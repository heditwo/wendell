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
import { Places } from "./Places.ts"
import { Recent } from "./Recent.ts"
import { Routing } from "./Routing.ts"
import { SessionKey } from "./SessionKey.ts"
import { Tasks } from "./Tasks.ts"
import { ToolCalls } from "./ToolCalls.ts"

const HANDOFF_MESSAGES = 15

const fail = (message: string) => Effect.fail(new ToolCalls.ToolFailure({ message }))

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
            if (Option.isSome(yield* tasks.get(channelId))) {
              return yield* fail("You are already in a task thread. Work here.")
            }

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

            yield* tasks.create(task).pipe(Effect.mapError(() => new ToolCalls.ToolFailure({ message: "Could not save the task." })))
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
            const updated = yield* tasks
              .update(channelId, { summary, status })
              .pipe(Effect.mapError(() => new ToolCalls.ToolFailure({ message: "Could not save the task." })))

            return Option.isSome(updated) ? "Task updated." : yield* fail("This conversation is not a task thread.")
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
