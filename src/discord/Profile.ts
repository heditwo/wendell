import { Context, Duration, Effect, FileSystem, Layer, Option, Ref, Schedule, Schema, Stream } from "effect"
import path from "node:path"
import { Discord } from "./Discord.ts"
import { Settings } from "../config/Settings.ts"

const Activity = Schema.Struct({
  type: Schema.Literals(["playing", "listening", "watching", "competing", "custom"]),
  text: Schema.String,
})

const StoredFile = Schema.Struct({
  status: Schema.Literals(["online", "idle", "dnd", "invisible"]),
  activity: Schema.NullOr(Activity),
})

interface StoredFile extends Schema.Schema.Type<typeof StoredFile> {}

export class ProfileFileError extends Schema.TaggedError<ProfileFileError>()("Profile.ProfileFileError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly presence: Effect.Effect<Discord.Presence>
  /** Sets the presence now and keeps it: Discord forgets it on every new gateway connection. */
  readonly setPresence: (presence: Discord.Presence) => Effect.Effect<void, ProfileFileError>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Profile") {}

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredFile))
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(StoredFile))

const toPresence = (stored: StoredFile): Discord.Presence => ({
  status: stored.status,
  activity: Option.fromNullishOr(stored.activity),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const discord = yield* Discord.Service
    const fs = yield* FileSystem.FileSystem
    const file = path.join(settings.dataDirectory, "profile.json")
    const fileError = (cause: unknown) => new ProfileFileError({ path: file, cause })

    const initial = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return { status: "online", activity: null } satisfies StoredFile

      return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeFile))
    }).pipe(Effect.mapError(fileError))

    const state = yield* Ref.make<StoredFile>(initial)

    const presence = Ref.get(state).pipe(Effect.map(toPresence))

    const setPresence = Effect.fn("Profile.setPresence")(function* (next: Discord.Presence) {
      const stored: StoredFile = { status: next.status, activity: Option.getOrNull(next.activity) }

      yield* Ref.set(state, stored)
      yield* discord.setPresence(next)
      yield* encodeFile(stored).pipe(
        Effect.flatMap((json) =>
          fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.andThen(fs.writeFileString(file, `${json}\n`))),
        ),
        Effect.mapError(fileError),
      )
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
