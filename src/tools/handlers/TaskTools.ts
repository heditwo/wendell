import { AbsolutePath } from "@opencode/client/effect"
import { Clock, Effect, Option } from "effect"
import path from "node:path"
import { Activity } from "../../conversations/Activity.ts"
import { Conversations } from "../../conversations/Conversations.ts"
import { Places } from "../../conversations/Places.ts"
import { Discord } from "../../discord/Discord.ts"
import { Attachments } from "../../inbound/Attachments.ts"
import { Inbound } from "../../inbound/Inbound.ts"
import { Recent } from "../../inbound/Recent.ts"
import { Routing } from "../../inbound/Routing.ts"
import { Recollection } from "../../memory/Recollection.ts"
import { Fleet } from "../../opencode/Fleet.ts"
import type { ChannelId, MessageId } from "../../shared/Ids.ts"
import { truncate } from "../../shared/Text.ts"
import { Tasks } from "../../tasks/Tasks.ts"
import { ToolCalls } from "../ToolCalls.ts"

const HANDOFF_MESSAGES = 15
const SHORT_BRIEF = 300

const saveFailure = ToolCalls.failure("Could not save the task.")

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

/** `wendell_start_task`, `wendell_continue_task` and `wendell_update_task`: tasks, sub-tasks and their hand-offs. */
export const make = Effect.gen(function* () {
  const discord = yield* Discord.Service
  const activity = yield* Activity.Service
  const tasks = yield* Tasks.Service
  const fleet = yield* Fleet.Service
  const conversations = yield* Conversations.Service
  const places = yield* Places.Service
  const recent = yield* Recent.Service
  const recollection = yield* Recollection.Service

  const requester = (messageId: MessageId) =>
    recent.get(messageId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => ToolCalls.fail(`Unknown message ${messageId}. Use the id of a message from this conversation.`),
          onSome: Effect.succeed,
        }),
      ),
    )

  const handoff = Effect.fn("TaskTools.handoff")(function* (
    lobby: ChannelId,
    directory: string,
    message: Inbound.Message,
    brief: string,
    title: string,
  ) {
    const earlier = yield* discord.transcript(lobby, Option.some(message.id), HANDOFF_MESSAGES).pipe(
      Effect.orElseSucceed(() => []),
    )

    return [
      `You started this task from <#${lobby}>: "${title}".`,
      `Your brief: ${brief}`,
      "",
      `Recent messages in <#${lobby}>, oldest first (context only):`,
      ...earlier.map((line) => `${line.isMe ? "Wendell (you)" : line.authorName}: ${line.content}`),
      "",
      "The request that started the task:",
      Inbound.render({ message, route: Routing.Route.Addressed(), files: Attachments.plan(directory, message) }),
      "",
      "Start the work now. Post updates and the result in this thread with wendell_reply.",
    ].join("\n")
  })

  const startInChannel = Effect.fn("TaskTools.startInChannel")(function* (
    { remote, channelId }: ToolCalls.Target,
    messageId: MessageId,
    title: string,
    brief: string,
  ) {
    const message = yield* requester(messageId)

    if (message.channelId !== channelId) return yield* ToolCalls.fail("That message is not in this conversation.")

    if (Inbound.isDirect(message)) return yield* ToolCalls.fail("DMs have no threads. Work on it here directly.")

    const slug = Tasks.slugify(title, yield* tasks.slugs(remote.name))
    const directory = AbsolutePath.make(path.join(remote.directory, slug))

    const threadId = yield* discord
      .startThread(channelId, message.id, title)
      .pipe(Effect.mapError(ToolCalls.failure("Could not start a thread here. Check that Wendell can create public threads.")))

    yield* fleet.makeDirectory(remote, directory).pipe(Effect.mapError(ToolCalls.failure("Could not create the project directory.")))

    const now = yield* Clock.currentTimeMillis

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
      createdBy: message.authorId,
      createdByName: message.authorName,
      createdAt: now,
      lastActivity: now,
    }

    yield* tasks.create(task).pipe(Effect.mapError(saveFailure))
    yield* activity.spoke(channelId)

    // A new task session has seen no notes yet: the brief decides which facts are relevant.
    const recalled = yield* recollection.before({
      conversationKey: `${remote.name}/${threadId}`,
      remote,
      place: { guildId: message.guildId, channelId: threadId },
      people: [{ userId: message.authorId, name: message.authorName }],
      text: `${message.authorName}: ${Inbound.plainText(message)}\nTask brief: ${brief}`,
    })

    yield* conversations
      .deliver(
        places.forTask(task),
        [...recalled.blocks, yield* handoff(channelId, remote.directory, message, brief, title)].join("\n\n"),
        { expectReply: true, progress: true, trigger: Option.some({ channelId, messageId: message.id }) },
        Attachments.images(Attachments.plan(remote.directory, message)),
      )
      .pipe(Effect.mapError(ToolCalls.failure("The thread exists, but the task could not start.")))
    yield* recalled.delivered
    yield* Effect.logInfo("Started task", { server: remote.name, threadId, slug })

    return `Started the task in <#${threadId}>. The work continues there. Do not reply in this channel.`
  })

  const startSubtask = Effect.fn("TaskTools.startSubtask")(function* (
    remote: Fleet.Remote,
    parent: Tasks.Task,
    title: string,
    brief: string,
  ) {
    const slug = Tasks.slugify(title, yield* tasks.slugs(remote.name))

    const worktree = yield* fleet
      .worktree(remote, AbsolutePath.make(parent.directory), slug)
      .pipe(Effect.mapError(ToolCalls.failure("Could not create a git worktree for the sub-task.")))

    const threadId = yield* discord
      .createThread(parent.parentId, title)
      .pipe(Effect.mapError(ToolCalls.failure("Could not start a thread. Check that Wendell can create public threads.")))

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
      createdBy: parent.createdBy,
      createdByName: parent.createdByName,
      createdAt: now,
      lastActivity: now,
      parentTaskId: parent.threadId,
      branch: Option.isSome(worktree) ? `wendell/${slug}` : undefined,
    }

    yield* tasks.create(task).pipe(Effect.mapError(saveFailure))
    yield* discord
      .send(threadId, `Sub-task of <#${parent.threadId}>: ${truncate(brief, SHORT_BRIEF)}`, Option.none())
      .pipe(Effect.mapError(ToolCalls.failure("Could not post in the sub-task thread.")))
    yield* discord
      .send(parent.threadId, `🧵 Sub-task started: <#${threadId}>`, Option.none())
      .pipe(Effect.mapError(ToolCalls.failure("Could not post the sub-task link.")))
    yield* activity.spoke(parent.threadId)
    yield* conversations
      .deliver(places.forTask(task), subtaskHandoff(parent, task, brief), {
        expectReply: true,
        progress: true,
        trigger: Option.none(),
      })
      .pipe(Effect.mapError(ToolCalls.failure("The thread exists, but the sub-task could not start.")))
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

  const startTask = Effect.fn("TaskTools.startTask")(function* (target: ToolCalls.Target, { messageId, title, brief }: ToolCalls.CallOf<"StartTask">) {
    const parent = yield* tasks.get(target.channelId)

    if (Option.isSome(parent)) return yield* startSubtask(target.remote, parent.value, title, brief)

    return yield* Option.match(messageId, {
      onNone: () => ToolCalls.fail("message_id is required when you start a task from a channel."),
      onSome: (id) => startInChannel(target, id, title, brief),
    })
  })

  const continueTask = Effect.fn("TaskTools.continueTask")(function* (
    { channelId }: ToolCalls.Target,
    { threadId, request: text, messageId }: ToolCalls.CallOf<"ContinueTask">,
  ) {
    const task = yield* tasks.get(threadId).pipe(
      Effect.flatMap(Option.match({ onNone: () => ToolCalls.fail("No task with that thread ID."), onSome: Effect.succeed })),
    )

    const message = yield* Option.match(messageId, {
      onNone: () => Effect.succeed(Option.none<Inbound.Message>()),
      onSome: (id) => recent.get(id),
    })

    const author = Option.match(message, { onNone: () => "Someone", onSome: (found) => found.authorName })

    yield* discord
      .send(task.threadId, `**${author}** in <#${channelId}>: ${text}`, Option.none())
      .pipe(Effect.mapError(ToolCalls.failure("Could not post in the task thread.")))
    yield* activity.spoke(channelId)

    yield* conversations
      .deliver(
        places.forTask(task),
        [`${author} asked about this task from <#${channelId}>. Their request:`, text, "Continue the work in this thread."].join("\n"),
        {
          expectReply: true,
          progress: true,
          trigger: Option.map(message, (found) => ({ channelId, messageId: found.id })),
        },
      )
      .pipe(Effect.mapError(ToolCalls.failure("Could not reach the task.")))

    return `Forwarded to <#${task.threadId}>. Do not reply in this channel.`
  })

  const reportDone = Effect.fn("TaskTools.reportDone")(function* (task: Tasks.Task, parentTaskId: ChannelId) {
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

  const updateTask = Effect.fn("TaskTools.updateTask")(function* (
    { channelId }: ToolCalls.Target,
    { summary, status }: ToolCalls.CallOf<"UpdateTask">,
  ) {
    const before = yield* tasks.get(channelId)
    const updated = yield* tasks.update(channelId, { summary, status }).pipe(Effect.mapError(saveFailure))

    if (Option.isNone(updated)) return yield* ToolCalls.fail("This conversation is not a task thread.")

    const finished = Option.exists(before, (task) => task.status !== "done") && updated.value.status === "done"
    const parentTaskId = Option.fromUndefinedOr(updated.value.parentTaskId)

    if (!finished || Option.isNone(parentTaskId)) return "Task updated."

    yield* reportDone(updated.value, parentTaskId.value).pipe(
      Effect.mapError(ToolCalls.failure("Task updated, but the parent task could not be reached.")),
    )

    return "Task updated. The result was reported to the parent task."
  })

  return { startTask, continueTask, updateTask }
})

export * as TaskTools from "./TaskTools.ts"
