import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import path from "node:path"
import { Settings } from "../config/Settings.ts"
import { ChannelId, GuildId, ServerName, UserId } from "../shared/Ids.ts"
import { JsonStore } from "../shared/JsonStore.ts"

export const Task = Schema.Struct({
  threadId: ChannelId,
  parentId: ChannelId,
  guildId: Schema.optional(GuildId),
  server: ServerName,
  slug: Schema.String,
  directory: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  status: Schema.Literals(["active", "done"]),
  createdBy: UserId,
  createdByName: Schema.String,
  createdAt: Schema.Number,
  lastActivity: Schema.Number,
  /** Set for sub-tasks: the thread of the task that started it. */
  parentTaskId: Schema.optional(ChannelId),
  /** Set for sub-tasks in a git worktree: the branch that the parent task merges. */
  branch: Schema.optional(Schema.String),
})

export interface Task extends Schema.Schema.Type<typeof Task> {}

const StoredFile = Schema.Struct({
  tasks: Schema.Record(Schema.String, Task),
})

export interface Interface {
  readonly get: (threadId: ChannelId) => Effect.Effect<Option.Option<Task>>
  readonly create: (task: Task) => Effect.Effect<void, JsonStore.StoreError>
  readonly update: (threadId: ChannelId, change: Change) => Effect.Effect<Option.Option<Task>, JsonStore.StoreError>
  readonly touch: (threadId: ChannelId) => Effect.Effect<void, JsonStore.StoreError>
  readonly recent: (guildId: Option.Option<GuildId>, limit: number) => Effect.Effect<ReadonlyArray<Task>>
  readonly slugs: (server: ServerName) => Effect.Effect<ReadonlySet<string>>
  readonly subtasks: (parentTaskId: ChannelId) => Effect.Effect<ReadonlyArray<Task>>
  readonly all: Effect.Effect<ReadonlyArray<Task>>
}

export interface Change {
  readonly summary: Option.Option<string>
  readonly status: Option.Option<Task["status"]>
}

const unchanged: Change = { summary: Option.none(), status: Option.none() }

export class Service extends Context.Service<Service, Interface>()("wendell/Tasks") {}

/** "Build a Todo App!" → "build-a-todo-app", unique among `taken`. */
export const slugify = (title: string, taken: ReadonlySet<string>) => {
  const base =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 40)
      .replaceAll(/-+$/g, "") || "task"

  if (!taken.has(base)) return base

  let index = 2

  while (taken.has(`${base}-${index}`)) index += 1

  return `${base}-${index}`
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const store = yield* JsonStore.make(StoredFile, path.join(settings.dataDirectory, "tasks.json"), { tasks: {} })

    const get = Effect.fn("Tasks.get")(function* (threadId: ChannelId) {
      return Option.fromNullishOr((yield* store.get).tasks[threadId])
    })

    const create = Effect.fn("Tasks.create")(function* (task: Task) {
      yield* store.update((current) => ({ tasks: { ...current.tasks, [task.threadId]: task } }))
    })

    const update = Effect.fn("Tasks.update")(function* (threadId: ChannelId, change: Change) {
      const now = yield* Clock.currentTimeMillis

      // Most conversations are not tasks; do not rewrite the file for them.
      if (Option.isNone(yield* get(threadId))) return Option.none<Task>()

      return yield* store.modify((current) => {
        const task = current.tasks[threadId]

        if (task === undefined) return [Option.none<Task>(), current]

        const next: Task = {
          ...task,
          summary: Option.getOrElse(change.summary, () => task.summary),
          status: Option.getOrElse(change.status, () => task.status),
          lastActivity: now,
        }

        return [Option.some(next), { tasks: { ...current.tasks, [threadId]: next } }]
      })
    })

    const touch = Effect.fn("Tasks.touch")(function* (threadId: ChannelId) {
      yield* update(threadId, unchanged)
    })

    const recent = Effect.fn("Tasks.recent")(function* (guildId: Option.Option<GuildId>, limit: number) {
      const all = Object.values((yield* store.get).tasks)
      const wanted = Option.getOrUndefined(guildId)

      return all
        .filter((task) => task.guildId === wanted)
        .toSorted((left, right) => right.lastActivity - left.lastActivity)
        .slice(0, limit)
    })

    const slugs = Effect.fn("Tasks.slugs")(function* (server: ServerName) {
      const all = Object.values((yield* store.get).tasks)

      return new Set(all.flatMap((task) => (task.server === server ? [task.slug] : [])))
    })

    const subtasks = Effect.fn("Tasks.subtasks")(function* (parentTaskId: ChannelId) {
      return Object.values((yield* store.get).tasks)
        .filter((task) => task.parentTaskId === parentTaskId)
        .toSorted((left, right) => left.createdAt - right.createdAt)
    })

    const all = store.get.pipe(Effect.map((current) => Object.values(current.tasks)))

    return Service.of({ get, create, update, touch, recent, slugs, subtasks, all })
  }),
)

export * as Tasks from "./Tasks.ts"
