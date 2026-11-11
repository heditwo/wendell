import { AbsolutePath } from "@opencode/client/effect"
import { Clock, Deferred, Effect, Layer, Option, Stream } from "effect"
import path from "node:path"
import { Access } from "./Access.ts"
import { Activity } from "./Activity.ts"
import { Conversations } from "./Conversations.ts"
import { Discord } from "./Discord.ts"
import { Fleet } from "./Fleet.ts"
import type { ChannelId, MessageId } from "./Ids.ts"
import { Inbound } from "./Inbound.ts"
import { Models } from "./Models.ts"
import { Places } from "./Places.ts"
import { Recent } from "./Recent.ts"
import { Routing } from "./Routing.ts"
import { SessionKey } from "./SessionKey.ts"
import { Tasks } from "./Tasks.ts"
import { ToolCalls } from "./ToolCalls.ts"

const HANDOFF_MESSAGES = 15

const SHORT_BRIEF = 300

const fail = (message: string) => Effect.fail(new ToolCalls.ToolFailure({ message }))

const saveFailure = () => new ToolCalls.ToolFailure({ message: "Could not save the task." })

const shorten = (text: string) => (text.length <= SHORT_BRIEF ? text : `${text.slice(0, SHORT_BRIEF - 1)}…`)

const discordFailure =
  (message: string) =>
  <A>(effect: Effect.Effect<A, Discord.DiscordError>) =>
    Effect.mapError(effect, () => new ToolCalls.ToolFailure({ message }))

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const toolCalls = yield* ToolCalls.Service
    const discord = yield* Discord.Service
    const activity = yield* Activity.Service
    const tasks = yield* Tasks.Service
    const fleet = yield* Fleet.Service
    const conversations = yield* Conversations.Service
    const places = yield* Places.Service
    const access = yield* Access.Service
    const recent = yield* Recent.Service
    const models = yield* Models.Service

    // Subagents' tool calls belong to the conversation at the top of their session tree.
    const channelOf = (remote: Fleet.Remote, sessionID: string) =>
      conversations.rootOf(remote, sessionID).pipe(
        Effect.map(Option.flatMap(SessionKey.channelOf)),
        Effect.flatMap(
          Option.match({
            onNone: () => fail("This session is not a Wendell conversation."),
            onSome: (channelId) => Effect.succeed(channelId),
          }),
        ),
      )

    const remoteOf = (request: ToolCalls.Request) =>
      Option.match(fleet.byName(request.server), {
        onNone: () => fail("This server is not connected."),
        onSome: Effect.succeed,
      })

    const requester = (messageId: MessageId) =>
      recent.get(messageId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => fail(`Unknown message ${messageId}. Use the id of a message from this conversation.`),
            onSome: Effect.succeed,
          }),
        ),
      )

    const handoff = Effect.fn("ToolWorker.handoff")(function* (
      lobby: ChannelId,
      message: Inbound.Message,
      brief: string,
      title: string,
    ) {
      const earlier = yield* discord.transcript(lobby, Option.some(message.id), HANDOFF_MESSAGES).pipe(
        Effect.orElseSucceed(() => []),
      )

      const trusted = yield* access.trusted(Inbound.member(message))

      return [
        `You started this task from <#${lobby}>: "${title}".`,
        `Your brief: ${brief}`,
        "",
        `Recent messages in <#${lobby}>, oldest first (context only):`,
        ...earlier.map((line) => `${line.isMe ? "Wendell (you)" : line.authorName}: ${line.content}`),
        "",
        "The request that started the task:",
        Inbound.render({ message, route: Routing.Route.Addressed(), trusted }),
        "",
        "Start the work now. Post updates and the result in this thread with wendell_reply.",
      ].join("\n")
    })

    const startTask = Effect.fn("ToolWorker.startTask")(function* (
      request: ToolCalls.Request,
      channelId: ChannelId,
      messageId: MessageId,
      title: string,
      brief: string,
    ) {
      const message = yield* requester(messageId)

      if (message.channelId !== channelId) return yield* fail("That message is not in this conversation.")

      if (Inbound.isDirect(message)) return yield* fail("DMs have no threads. Work on it here directly.")

      const remote = yield* remoteOf(request)
      const slug = Tasks.slugify(title, yield* tasks.slugs(remote.name))
      const directory = AbsolutePath.make(path.join(remote.directory, slug))

      const threadId = yield* discord
        .startThread(channelId, message.id, title)
        .pipe(discordFailure("Could not start a thread here. Check that Wendell can create public threads."))

      yield* fleet
        .makeDirectory(remote, directory)
        .pipe(Effect.mapError(() => new ToolCalls.ToolFailure({ message: "Could not create the project directory." })))

      const now = yield* Clock.currentTimeMillis
      const trusted = yield* access.trusted(Inbound.member(message))

      const task: Tasks.Task = {
        threadId,
        parentId: channelId,
        guildId: Option.getOrUndefined(message.guildId),
        server: remote.name,
        slug,
        directory,
        title,
        summary: brief,
        status: "active",
        trusted,
        createdBy: message.authorId,
        createdByName: message.authorName,
        createdAt: now,
        lastActivity: now,
      }

      yield* tasks.create(task).pipe(Effect.mapError(saveFailure))
      yield* activity.spoke(channelId)
      yield* conversations
        .deliver(places.forTask(task), yield* handoff(channelId, message, brief, title), {
          expectReply: true,
          progress: true,
          trigger: Option.some({ channelId, messageId: message.id }),
        })
        .pipe(Effect.mapError(() => new ToolCalls.ToolFailure({ message: "The thread exists, but the task could not start." })))
      yield* Effect.logInfo("Started task", { server: remote.name, threadId, slug, trusted })

      return `Started the task in <#${threadId}>. The work continues there. Do not reply in this channel.`
    })

    const subtaskHandoff = (parent: Tasks.Task, task: Tasks.Task, brief: string) =>
      [
        `You are a sub-task of the task <#${parent.threadId}> "${parent.title}", started by ${parent.createdByName}.`,
        `The parent task: ${parent.summary}`,
        "",
        `Your sub-task: "${task.title}".`,
        `Your brief: ${brief}`,
        "",
        task.branch === undefined
          ? `Your working directory is ${task.directory}. You share the directory with the parent task; only touch what your brief assigns you.`
          : `Your working directory is ${task.directory}, a separate git worktree of the parent task's repository. ` +
            `It starts on a detached HEAD. First run \`git switch -c ${task.branch}\`, then commit your work on that branch, ` +
            "so the parent task can merge it. Work in this directory; do not create another worktree.",
        "",
        'When your part is finished, call wendell_update_task with status "done" and a summary of the result. ' +
          "The summary is reported back to the parent task automatically.",
        "Start the work now. Post updates and the result in this thread with wendell_reply.",
      ].join("\n")

    const startSubtask = Effect.fn("ToolWorker.startSubtask")(function* (
      remote: Fleet.Remote,
      parent: Tasks.Task,
      title: string,
      brief: string,
    ) {
      const slug = Tasks.slugify(title, yield* tasks.slugs(remote.name))

      const worktree = yield* fleet
        .worktree(remote, AbsolutePath.make(parent.directory), slug)
        .pipe(Effect.mapError(() => new ToolCalls.ToolFailure({ message: "Could not create a git worktree for the sub-task." })))

      const threadId = yield* discord
        .createThread(parent.parentId, title)
        .pipe(discordFailure("Could not start a thread. Check that Wendell can create public threads."))

      const now = yield* Clock.currentTimeMillis

      const task: Tasks.Task = {
        threadId,
        parentId: parent.parentId,
        guildId: parent.guildId,
        server: remote.name,
        slug,
        directory: Option.getOrElse(worktree, () => parent.directory),
        title,
        summary: brief,
        status: "active",
        trusted: parent.trusted,
        createdBy: parent.createdBy,
        createdByName: parent.createdByName,
        createdAt: now,
        lastActivity: now,
        parentTaskId: parent.threadId,
        branch: Option.isSome(worktree) ? `wendell/${slug}` : undefined,
      }

      yield* tasks.create(task).pipe(Effect.mapError(saveFailure))
      yield* discord
        .send(threadId, `Sub-task of <#${parent.threadId}>: ${shorten(brief)}`, Option.none())
        .pipe(discordFailure("Could not post in the sub-task thread."))
      yield* discord
        .send(parent.threadId, `🧵 Sub-task started: <#${threadId}>`, Option.none())
        .pipe(discordFailure("Could not post the sub-task link."))
      yield* activity.spoke(parent.threadId)
      yield* conversations
        .deliver(places.forTask(task), subtaskHandoff(parent, task, brief), {
          expectReply: true,
          progress: true,
          trigger: Option.none(),
        })
        .pipe(Effect.mapError(() => new ToolCalls.ToolFailure({ message: "The thread exists, but the sub-task could not start." })))
      yield* Effect.logInfo("Started sub-task", {
        server: remote.name,
        threadId,
        parent: parent.threadId,
        slug,
        worktree: Option.isSome(worktree),
      })

      return (
        `Started the sub-task in <#${threadId}> (thread_id=${threadId}, directory ${task.directory}). ` +
        "It reports back here when it is done. Do not do its part yourself."
      )
    })

    const reportDone = Effect.fn("ToolWorker.reportDone")(function* (task: Tasks.Task, parentTaskId: ChannelId) {
      const parent = yield* tasks.get(parentTaskId)

      if (Option.isNone(parent)) return

      const open = (yield* tasks.subtasks(parentTaskId)).filter((sibling) => sibling.status === "active")

      yield* discord.send(parent.value.threadId, `✅ <#${task.threadId}> is done.`, Option.none()).pipe(Effect.ignore)
      yield* conversations.deliver(
        places.forTask(parent.value),
        [
          `Sub-task <#${task.threadId}> "${task.title}" is done.`,
          `Summary: ${task.summary}`,
          `Directory: ${task.directory}`,
          ...(task.branch === undefined ? [] : [`Branch: ${task.branch}. Review it and merge it into your work.`]),
          open.length === 0
            ? "All sub-tasks of this task are done."
            : `Sub-tasks still active: ${open.map((sibling) => `<#${sibling.threadId}>`).join(", ")}.`,
          "Continue the work in this thread.",
        ].join("\n"),
        { expectReply: false, progress: true, trigger: Option.none() },
      )
    })

    const handle = Effect.fn("ToolWorker.handle")(function* (request: ToolCalls.Request) {
      const channelId = yield* channelOf(yield* remoteOf(request), request.sessionID)

      return yield* ToolCalls.Call.$match(request.call, {
        Reply: ({ text, replyTo }) =>
          Effect.gen(function* () {
            const messageId = yield* discord.send(channelId, text, replyTo).pipe(discordFailure("Could not post the message."))

            yield* activity.spoke(channelId)

            return `Posted message ${messageId}.`
          }),

        React: ({ messageId, emoji }) =>
          Effect.gen(function* () {
            yield* discord.react(channelId, messageId, emoji).pipe(discordFailure("Could not add the reaction."))
            yield* activity.spoke(channelId)

            return "Reacted."
          }),

        StartTask: ({ messageId, title, brief }) =>
          Effect.gen(function* () {
            const parent = yield* tasks.get(channelId)

            if (Option.isSome(parent)) return yield* startSubtask(yield* remoteOf(request), parent.value, title, brief)

            return yield* Option.match(messageId, {
              onNone: () => fail("message_id is required when you start a task from a channel."),
              onSome: (id) => startTask(request, channelId, id, title, brief),
            })
          }),

        ContinueTask: ({ threadId, request: text, messageId }) =>
          Effect.gen(function* () {
            const task = yield* tasks.get(threadId).pipe(
              Effect.flatMap(Option.match({ onNone: () => fail("No task with that thread ID."), onSome: Effect.succeed })),
            )

            const message = yield* Option.match(messageId, {
              onNone: () => Effect.succeed(Option.none<Inbound.Message>()),
              onSome: (id) => recent.get(id),
            })

            const author = Option.match(message, { onNone: () => "Someone", onSome: (found) => found.authorName })

            yield* discord
              .send(task.threadId, `**${author}** in <#${channelId}>: ${text}`, Option.none())
              .pipe(discordFailure("Could not post in the task thread."))
            yield* activity.spoke(channelId)

            const trusted = yield* Option.match(message, {
              onNone: () => Effect.succeed(false),
              onSome: (found) => access.trusted(Inbound.member(found)),
            })

            yield* conversations
              .deliver(
                places.forTask(task),
                [
                  `${author} asked about this task from <#${channelId}> (trusted=${trusted}). Their request:`,
                  text,
                  "Continue the work in this thread.",
                ].join("\n"),
                {
                  expectReply: true,
                  progress: true,
                  trigger: Option.map(message, (found) => ({ channelId, messageId: found.id })),
                },
              )
              .pipe(Effect.mapError(() => new ToolCalls.ToolFailure({ message: "Could not reach the task." })))

            return `Forwarded to <#${task.threadId}>. Do not reply in this channel.`
          }),

        UpdateTask: ({ summary, status }) =>
          Effect.gen(function* () {
            const before = yield* tasks.get(channelId)
            const updated = yield* tasks.update(channelId, { summary, status }).pipe(Effect.mapError(saveFailure))

            if (Option.isNone(updated)) return yield* fail("This conversation is not a task thread.")

            const finished = Option.exists(before, (task) => task.status !== "done") && updated.value.status === "done"
            const parentTaskId = Option.fromUndefinedOr(updated.value.parentTaskId)

            if (!finished || Option.isNone(parentTaskId)) return "Task updated."

            yield* reportDone(updated.value, parentTaskId.value).pipe(
              Effect.mapError(() => new ToolCalls.ToolFailure({ message: "Task updated, but the parent task could not be reached." })),
            )

            return "Task updated. The result was reported to the parent task."
          }),

        SetModel: ({ model, scope }) =>
          Effect.gen(function* () {
            const remote = yield* remoteOf(request)

            const conversation = yield* conversations.forSession(remote.name, SessionKey.forChannel(channelId)).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => fail("This conversation is not ready yet. Try again in your next turn."),
                  onSome: Effect.succeed,
                }),
              ),
            )

            if (conversation.tier !== "trusted") {
              return yield* fail("Only trusted people can change the model, and this conversation is not trusted.")
            }

            const resolved = yield* models.resolve(remote, conversation.directory, model).pipe(
              Effect.catchTags({
                "Models.UnknownModel": (error) => fail(error.message),
                "Models.CatalogError": () => fail("Could not read the server's models."),
              }),
            )

            if (scope === "default") {
              yield* models.setDefault(remote, resolved.id).pipe(Effect.mapError(() => new ToolCalls.ToolFailure({ message: "Could not save the model." })))

              return `New conversations on ${remote.name} now use ${resolved.name} (${resolved.id}). Existing conversations keep their model.`
            }

            yield* conversations
              .setModel(conversation, resolved)
              .pipe(Effect.mapError(() => new ToolCalls.ToolFailure({ message: "Could not switch the model." })))

            return `This conversation now uses ${resolved.name} (${resolved.id}), from your next turn.`
          }),
      })
    })

    yield* toolCalls.requests.pipe(
      Stream.runForEach((request) =>
        handle(request).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(request.done, exit)),
          Effect.forkScoped,
        ),
      ),
      Effect.forkScoped,
    )
  }),
)

export * as ToolWorker from "./ToolWorker.ts"
