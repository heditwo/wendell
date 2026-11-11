import { Context, Duration, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import path from "node:path"
import { Settings } from "../config/Settings.ts"
import { JsonStore } from "../shared/JsonStore.ts"
import { Discord } from "./Discord.ts"
import { Presence } from "./Presence.ts"

const StoredFile = Schema.Struct({
  status: Presence.Status,
  activity: Schema.NullOr(Schema.Struct({ type: Presence.ActivityType, text: Schema.String })),
})

interface StoredFile extends Schema.Schema.Type<typeof StoredFile> {}

export interface Interface {
  readonly presence: Effect.Effect<Presence.Presence>
  /** Sets the presence now and keeps it: Discord forgets it on every new gateway connection. */
  readonly setPresence: (presence: Presence.Presence) => Effect.Effect<void, JsonStore.StoreError>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Profile") {}

const toPresence = (stored: StoredFile): Presence.Presence => ({
  status: stored.status,
  activity: Option.fromNullishOr(stored.activity),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const discord = yield* Discord.Service

    const store = yield* JsonStore.make(StoredFile, path.join(settings.dataDirectory, "profile.json"), {
      status: "online",
      activity: null,
    })

    const presence = store.get.pipe(Effect.map(toPresence))

    const setPresence = Effect.fn("Profile.setPresence")(function* (next: Presence.Presence) {
      yield* discord.setPresence(next)
      yield* store.update(() => ({ status: next.status, activity: Option.getOrNull(next.activity) }))
    })

    const apply = presence.pipe(
      Effect.flatMap(discord.setPresence),
      Effect.flatMap((sent) => (sent ? Effect.void : Effect.fail("not connected"))),
    )

    // The first connection can open before this layer listens for it, so retry until a send succeeds.
    yield* apply.pipe(
      Effect.retry({ schedule: Schedule.spaced(Duration.seconds(2)), times: 30 }),
      Effect.catch(() => Effect.logWarning("Could not set Wendell's presence")),
      Effect.forkScoped,
    )
    yield* discord.connected.pipe(Stream.runForEach(() => apply.pipe(Effect.ignore)), Effect.forkScoped)

    return Service.of({ presence, setPresence })
  }),
)

export * as Profile from "./Profile.ts"
