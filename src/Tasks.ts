import { Clock, Context, Effect, FileSystem, Layer, Option, Ref, Schema, Semaphore } from "effect"
import path from "node:path"
import { ChannelId, GuildId, ServerName, UserId } from "./Ids.ts"
import { Settings } from "./Settings.ts"

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
  trusted: Schema.Boolean,
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

interface StoredFile extends Schema.Schema.Type<typeof StoredFile> {}

export class TasksFileError extends Schema.TaggedError<TasksFileError>()("Tasks.TasksFileError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly get: (threadId: ChannelId) => Effect.Effect<Option.Option<Task>>
  readonly create: (task: Task) => Effect.Effect<void, TasksFileError>
  readonly update: (threadId: ChannelId, change: Change) => Effect.Effect<Option.Option<Task>, TasksFileError>
  readonly touch: (threadId: ChannelId) => Effect.Effect<void, TasksFileError>
  readonly recent: (guildId: Option.Option<GuildId>, limit: number) => Effect.Effect<ReadonlyArray<Task>>
  readonly slugs: (server: ServerName) => Effect.Effect<ReadonlySet<string>>
  readonly subtasks: (parentTaskId: ChannelId) => Effect.Effect<ReadonlyArray<Task>>
}

export interface Change {
  readonly summary: Option.Option<string>
  readonly status: Option.Option<Task["status"]>
}

const unchanged: Change = { summary: Option.none(), status: Option.none() }

export class Service extends Context.Service<Service, Interface>()("wendell/Tasks") {}

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredFile))
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(StoredFile))

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
    const fs = yield* FileSystem.FileSystem
    const file = path.join(settings.dataDirectory, "tasks.json")
    const fileError = (cause: unknown) => new TasksFileError({ path: file, cause })

    const initial = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return { tasks: {} }

      return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeFile))
    }).pipe(Effect.mapError(fileError))

    const state = yield* Ref.make<StoredFile>(initial)
    const writes = yield* Semaphore.make(1)

    const persist = Effect.gen(function* () {
      const json = yield* encodeFile(yield* Ref.get(state))

      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, `${json}\n`)
    }).pipe(Effect.mapError(fileError), Semaphore.withPermits(writes, 1))

    const get = Effect.fn("Tasks.get")(function* (threadId: ChannelId) {
      return Option.fromNullishOr((yield* Ref.get(state)).tasks[threadId])
    })

    const create = Effect.fn("Tasks.create")(function* (task: Task) {
      yield* Ref.update(state, (current) => ({ tasks: { ...current.tasks, [task.threadId]: task } }))
      yield* persist
    })

    const update = Effect.fn("Tasks.update")(function* (threadId: ChannelId, change: Change) {
      const now = yield* Clock.currentTimeMillis

      const updated = yield* Ref.modify(state, (current) => {
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

      if (Option.isSome(updated)) yield* persist

      return updated
    })

    const touch = Effect.fn("Tasks.touch")(function* (threadId: ChannelId) {
      yield* update(threadId, unchanged)
    })

    const recent = Effect.fn("Tasks.recent")(function* (guildId: Option.Option<GuildId>, limit: number) {
      const all = Object.values((yield* Ref.get(state)).tasks)
      const wanted = Option.getOrUndefined(guildId)

      return all
        .filter((task) => task.guildId === wanted)
        .toSorted((left, right) => right.lastActivity - left.lastActivity)
        .slice(0, limit)
    })

    const slugs = Effect.fn("Tasks.slugs")(function* (server: ServerName) {
      const all = Object.values((yield* Ref.get(state)).tasks)

      return new Set(all.flatMap((task) => (task.server === server ? [task.slug] : [])))
    })

    const subtasks = Effect.fn("Tasks.subtasks")(function* (parentTaskId: ChannelId) {
      return Object.values((yield* Ref.get(state)).tasks)
        .filter((task) => task.parentTaskId === parentTaskId)
        .toSorted((left, right) => left.createdAt - right.createdAt)
    })

    return Service.of({ get, create, update, touch, recent, slugs, subtasks })
  }),
)

export * as Tasks from "./Tasks.ts"
