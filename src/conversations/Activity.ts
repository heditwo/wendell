import { Clock, Context, Duration, Effect, Layer, Option, Schema } from "effect"
import path from "node:path"
import { Settings } from "../config/Settings.ts"
import { ChannelId } from "../shared/Ids.ts"
import { JsonStore } from "../shared/JsonStore.ts"

export interface Interface {
  readonly spoke: (channelId: ChannelId) => Effect.Effect<void>
  readonly spokeWithin: (channelId: ChannelId, window: Duration.Duration) => Effect.Effect<boolean>
  readonly spokeSince: (channelId: ChannelId, since: number) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Activity") {}

const StoredFile = Schema.Record(Schema.String, Schema.Number).check(Schema.isPropertyNames(ChannelId))

// Kept on disk, so a restart does not make Wendell forget that he just spoke in a conversation.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const store = yield* JsonStore.makeOrReset(StoredFile, path.join(settings.dataDirectory, "activity.json"), {})

    const lastSpoke = (channelId: ChannelId) => store.get.pipe(Effect.map((all) => Option.fromUndefinedOr(all[channelId])))

    const spoke = Effect.fn("Activity.spoke")(function* (channelId: ChannelId) {
      const now = yield* Clock.currentTimeMillis

      yield* store
        .update((all) => ({ ...all, [channelId]: now }))
        .pipe(Effect.catch((cause) => Effect.logWarning("Could not save the activity file", { cause })))
    })

    const spokeWithin = Effect.fn("Activity.spokeWithin")(function* (channelId: ChannelId, window: Duration.Duration) {
      const now = yield* Clock.currentTimeMillis

      return Option.exists(yield* lastSpoke(channelId), (time) => now - time <= Duration.toMillis(window))
    })

    const spokeSince = Effect.fn("Activity.spokeSince")(function* (channelId: ChannelId, since: number) {
      return Option.exists(yield* lastSpoke(channelId), (time) => time >= since)
    })

    return Service.of({ spoke, spokeWithin, spokeSince })
  }),
)

export * as Activity from "./Activity.ts"
