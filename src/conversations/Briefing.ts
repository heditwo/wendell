import { Effect, Option } from "effect"
import { Settings } from "../config/Settings.ts"
import { Models } from "../opencode/Models.ts"
import { isoDay } from "../shared/Text.ts"
import { Tasks } from "../tasks/Tasks.ts"
import type { Conversation } from "./Conversation.ts"

const RECENT_TASKS = 15

const describeTask = (task: Tasks.Task) =>
  `<#${task.threadId}> thread_id=${task.threadId} "${task.title}" (${task.status}, started by ${task.createdByName}, ` +
  `last active ${isoDay(task.lastActivity)}, directory ${task.directory}): ${task.summary}`

const describeTasks = (tasks: ReadonlyArray<Tasks.Task>) => {
  if (tasks.length === 0) return "There are no tasks yet."

  const listed = new Set(tasks.map((task) => task.threadId))

  const isTop = (task: Tasks.Task) => task.parentTaskId === undefined || !listed.has(task.parentTaskId)

  const lines = (task: Tasks.Task, depth: number): ReadonlyArray<string> => [
    `${"  ".repeat(depth)}- ${describeTask(task)}` +
      (depth === 0 && task.parentTaskId !== undefined ? ` (sub-task of <#${task.parentTaskId}>)` : ""),
    ...tasks.filter((child) => child.parentTaskId === task.threadId).flatMap((child) => lines(child, depth + 1)),
  ]

  return tasks
    .filter(isTop)
    .flatMap((task) => lines(task, 0))
    .join("\n")
}

const describeSubtask = (task: Tasks.Task) =>
  `- <#${task.threadId}> thread_id=${task.threadId} "${task.title}" (${task.status}, directory ${task.directory}` +
  `${task.branch === undefined ? "" : `, branch ${task.branch}`}): ${task.summary}`

/**
 * The conversation's context entry in the session's instructions: where Wendell is, his model, and the
 * tasks he can refer to.
 */
export const make = Effect.gen(function* () {
  const settings = yield* Settings.Service
  const tasks = yield* Tasks.Service
  const models = yield* Models.Service

  return Effect.fn("Briefing.contextFor")(function* (conversation: Conversation) {
    const model = Option.match(yield* models.chosen(conversation.remote, conversation.channelId), {
      onNone: () => "the agent's default model",
      onSome: (ref) => ref,
    })

    const where = [
      `This conversation is in Discord <#${conversation.channelId}>. Your working directory is ${conversation.directory}.`,
      `Your model here: ${model}. When someone asks for another model, use set_model.`,
      `People's time zone is ${settings.timeZone} unless they say otherwise. Pass it as tz to schedule_create.`,
      (yield* conversation.remote.capabilities).imageGeneration
        ? "You can make images with image_generate. It runs in the background: say in one short sentence that you " +
          "started it, then end your turn. When the notice with the saved path comes, post the image with wendell_reply and files. " +
          "For a new avatar, make a square image first."
        : "You cannot make images on this server. If someone asks for one, say so briefly.",
    ].join("\n")

    if (conversation.kind === "task") {
      const task = yield* tasks.get(conversation.channelId)
      const subtasks = yield* tasks.subtasks(conversation.channelId)

      const parent = yield* Option.match(Option.flatMap(task, (current) => Option.fromUndefinedOr(current.parentTaskId)), {
        onNone: () => Effect.succeed(Option.none<Tasks.Task>()),
        onSome: tasks.get,
      })

      return [
        where,
        "This is a task thread: one piece of real work. Everything said here is about it.",
        ...Option.match(task, {
          onNone: () => [],
          onSome: (current) => [
            `Task: "${current.title}", started by ${current.createdByName}. Status: ${current.status}.`,
            `What you recorded so far: ${current.summary}`,
          ],
        }),
        ...Option.match(parent, {
          onNone: () => [],
          onSome: (owner) => [
            `This is a sub-task of <#${owner.threadId}> "${owner.title}": ${owner.summary}`,
            Option.exists(task, (current) => current.directory === owner.directory)
              ? "You share the directory with the parent task. Only touch what your brief assigns you."
              : "You work in your own git worktree. Commit your work on your branch so the parent task can merge it.",
            'When you call update_task with status "done", your summary is reported to the parent task automatically.',
          ],
        }),
        "You can edit files and run commands in your working directory. For long-running processes such as dev servers or tunnels, use background shell jobs.",
        "Keep the task record current with update_task after meaningful progress.",
        "For a large, independent part of the work, call start_task without message_id to start a sub-task in its own thread.",
        ...(subtasks.length === 0
          ? []
          : ["Sub-tasks of this task, oldest first. They report here when they are done:", ...subtasks.map(describeSubtask)]),
      ].join("\n")
    }

    const recent = yield* tasks.recent(conversation.guildId, RECENT_TASKS)

    return [
      where,
      conversation.kind === "dm"
        ? "This is a private DM. You can work here directly; DMs have no threads."
        : "This is a shared channel. Answer quick questions here. For real work, call start_task to move it into its own thread.",
      "You can use the full setup here: edit files, run commands and use subagents.",
      "Tasks in this server, most recent first. When someone refers to earlier work, find it here and use continue_task:",
      describeTasks(recent),
    ].join("\n")
  })
})

export * as Briefing from "./Briefing.ts"
