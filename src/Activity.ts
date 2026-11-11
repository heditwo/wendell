import { Clock, Context, Duration, Effect, HashMap, Layer, Option, Ref } from "effect"
import type { ChannelId } from "./Ids.ts"

export interface Interface {
  readonly spoke: (channelId: ChannelId) => Effect.Effect<void>
  readonly spokeWithin: (channelId: ChannelId, window: Duration.Duration) => Effect.Effect<boolean>
  readonly spokeSince: (channelId: ChannelId, since: number) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Activity") {}

export const make = Effect.gen(function* () {
  const lastSpoke = yield* Ref.make(HashMap.empty<ChannelId, number>())

  const spoke = Effect.fn("Activity.spoke")(function* (channelId: ChannelId) {
    const now = yield* Clock.currentTimeMillis
    yield* Ref.update(lastSpoke, HashMap.set(channelId, now))
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
