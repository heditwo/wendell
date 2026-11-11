import { Context, Effect, FileSystem, Layer, Option, Ref, Schema, Semaphore } from "effect"
import path from "node:path"
import type { Fleet } from "./Fleet.ts"
import { ChannelId } from "./Ids.ts"
import { Settings } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { WendellConfig } from "./WendellConfig.ts"

export const Mode = WendellConfig.BusyMode

export type Mode = WendellConfig.BusyMode

export const DEFAULT_MODE: Mode = "interrupt"

const MAX_PARENTS = 8

const StoredFile = Schema.Struct({
  conversations: Schema.Record(Schema.String, Mode).check(Schema.isPropertyNames(ChannelId)),
})

interface StoredFile extends Schema.Schema.Type<typeof StoredFile> {}

export class BusyModesFileError extends Schema.TaggedError<BusyModesFileError>()(
  "BusyModes.BusyModesFileError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface Interface {
  /** The conversation's own mode, then its parent tasks' modes, then `servers.<name>.busy`. */
  readonly modeFor: (remote: Fleet.Remote, channelId: ChannelId) => Effect.Effect<Mode>
  readonly set: (channelId: ChannelId, mode: Mode) => Effect.Effect<void, BusyModesFileError>
}

export class Service extends Context.Service<Service, Interface>()("wendell/BusyModes") {}

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredFile))
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(StoredFile))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const tasks = yield* Tasks.Service
    const fs = yield* FileSystem.FileSystem
    const file = path.join(settings.dataDirectory, "busy.json")
    const fileError = (cause: unknown) => new BusyModesFileError({ path: file, cause })

    const initial = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return { conversations: {} }

      return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeFile))
    }).pipe(Effect.mapError(fileError))

    const state = yield* Ref.make<StoredFile>(initial)
    const writes = yield* Semaphore.make(1)

    const persist = Effect.gen(function* () {
      const json = yield* encodeFile(yield* Ref.get(state))

      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, `${json}\n`)
    }).pipe(Effect.mapError(fileError), Semaphore.withPermits(writes, 1))

    const modeFor = Effect.fn("BusyModes.modeFor")(function* (remote: Fleet.Remote, channelId: ChannelId) {
      const { conversations } = yield* Ref.get(state)
      let current = Option.some(channelId)

      // Sub-tasks follow their parent task until someone sets their own mode.
      for (let depth = 0; depth < MAX_PARENTS && Option.isSome(current); depth += 1) {
        const own = conversations[current.value]

        if (own !== undefined) return own

        const task = yield* tasks.get(current.value)

        current = Option.flatMap(task, (found) => Option.fromUndefinedOr(found.parentTaskId))
      }

      return remote.prefs.busy ?? DEFAULT_MODE
    })

    const set = Effect.fn("BusyModes.set")(function* (channelId: ChannelId, mode: Mode) {
      yield* Ref.update(state, (current) => ({ conversations: { ...current.conversations, [channelId]: mode } }))
      yield* persist
    })

    return Service.of({ modeFor, set })
  }),
)

export * as BusyModes from "./BusyModes.ts"
