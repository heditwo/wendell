import { Clock, Context, Duration, Effect, FileSystem, HashMap, Layer, Option, Ref, Schema, Semaphore } from "effect"
import path from "node:path"
import { ChannelId } from "../shared/Ids.ts"
import { Settings } from "../config/Settings.ts"

export interface Interface {
  readonly spoke: (channelId: ChannelId) => Effect.Effect<void>
  readonly spokeWithin: (channelId: ChannelId, window: Duration.Duration) => Effect.Effect<boolean>
  readonly spokeSince: (channelId: ChannelId, since: number) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Activity") {}

const StoredFile = Schema.Record(Schema.String, Schema.Number).check(Schema.isPropertyNames(ChannelId))

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredFile))
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(StoredFile))

// Kept on disk, so a restart does not make Wendell forget that he just spoke in a conversation.
export const make = Effect.gen(function* () {
  const settings = yield* Settings.Service
  const fs = yield* FileSystem.FileSystem
  const file = path.join(settings.dataDirectory, "activity.json")

  const initial = yield* Effect.gen(function* () {
    if (!(yield* fs.exists(file))) return HashMap.empty<ChannelId, number>()

    const stored = yield* fs.readFileString(file).pipe(Effect.flatMap(decodeFile))

    return HashMap.fromIterable(Object.entries(stored).map(([channelId, time]) => [ChannelId.make(channelId), time] as const))
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not read the activity file, starting empty", { cause }).pipe(
        Effect.as(HashMap.empty<ChannelId, number>()),
      ),
    ),
  )

  const lastSpoke = yield* Ref.make(initial)
  const writes = yield* Semaphore.make(1)

  const persist = Effect.gen(function* () {
    const json = yield* encodeFile(Object.fromEntries(HashMap.toEntries(yield* Ref.get(lastSpoke))))

    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, `${json}\n`)
  }).pipe(
    Semaphore.withPermits(writes, 1),
    Effect.catch((cause) => Effect.logWarning("Could not save the activity file", { cause })),
  )

  const spoke = Effect.fn("Activity.spoke")(function* (channelId: ChannelId) {
    const now = yield* Clock.currentTimeMillis

    yield* Ref.update(lastSpoke, HashMap.set(channelId, now))
    yield* persist
  })

  const spokeWithin = Effect.fn("Activity.spokeWithin")(function* (channelId: ChannelId, window: Duration.Duration) {
    const now = yield* Clock.currentTimeMillis
    const last = HashMap.get(yield* Ref.get(lastSpoke), channelId)

    return Option.match(last, {
      onNone: () => false,
      onSome: (time) => now - time <= Duration.toMillis(window),
    })
  })

  const spokeSince = Effect.fn("Activity.spokeSince")(function* (channelId: ChannelId, since: number) {
    return Option.exists(HashMap.get(yield* Ref.get(lastSpoke), channelId), (time) => time >= since)
  })

  return Service.of({ spoke, spokeWithin, spokeSince })
})

export const layer = Layer.effect(Service, make)

export * as Activity from "./Activity.ts"
