import { Clock, Context, Duration, Effect, Layer, Option, Schema } from "effect"
import path from "node:path"
import { Settings } from "../config/Settings.ts"
import { ChannelId, GuildId, UserId } from "../shared/Ids.ts"
import { JsonStore } from "../shared/JsonStore.ts"
import { attribute } from "../shared/Text.ts"
import type { Inbound } from "./Inbound.ts"

const PLACES_PER_PERSON = 8
const KEEP = Duration.days(7)

// Each message would otherwise write the file.
const REFRESH_AFTER = Duration.minutes(1)

export const Place = Schema.Struct({
  channelId: ChannelId,
  guildId: GuildId,
  at: Schema.Number,
})

export interface Place extends Schema.Schema.Type<typeof Place> {}

const StoredFile = Schema.Record(Schema.String, Schema.Array(Place)).check(Schema.isPropertyNames(UserId))

export interface Interface {
  /** Records where a person wrote in a Discord server. DMs and bots are not recorded. */
  readonly record: (message: Inbound.Message) => Effect.Effect<void>
  /** The server channels where the person wrote in the last 7 days, most recent first. */
  readonly of: (userId: UserId) => Effect.Effect<ReadonlyArray<Place>>
}

export const ago = (millis: number) => {
  const minutes = Math.max(1, Math.round(millis / 60_000))

  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.round(minutes / 60)

  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/** One line for each place, with the channel's name when it is known. */
export const render = (places: ReadonlyArray<{ readonly place: Place; readonly name: Option.Option<string> }>, now: number) =>
  places
    .map(
      ({ place, name }) =>
        `- <#${place.channelId}> channel_id=${place.channelId}` +
        `${Option.match(name, { onNone: () => "", onSome: (value) => ` name="${attribute(value)}"` })}, ${ago(now - place.at)}`,
    )
    .join("\n")

export class Service extends Context.Service<Service, Interface>()("wendell/RecentPlaces") {}

/** The server channels where each person wrote recently, so a DM can refer to them (`.data/places.json`). */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const store = yield* JsonStore.makeOrReset(StoredFile, path.join(settings.dataDirectory, "places.json"), {})

    const fresh = (places: ReadonlyArray<Place>, now: number) => places.filter((place) => now - place.at <= Duration.toMillis(KEEP))

    const record = Effect.fn("RecentPlaces.record")(function* (message: Inbound.Message) {
      if (message.authorIsBot || Option.isNone(message.guildId)) return

      const guildId = message.guildId.value
      const now = yield* Clock.currentTimeMillis
      const known = (yield* store.get)[message.authorId] ?? []
      const same = known.find((place) => place.channelId === message.channelId)

      if (same !== undefined && now - same.at < Duration.toMillis(REFRESH_AFTER)) return

      const place: Place = { channelId: message.channelId, guildId, at: now }

      yield* store
        .update((all) => ({
          ...all,
          [message.authorId]: [place, ...fresh(all[message.authorId] ?? [], now).filter((other) => other.channelId !== place.channelId)].slice(
            0,
            PLACES_PER_PERSON,
          ),
        }))
        .pipe(Effect.catch((cause) => Effect.logWarning("Could not save the places file", { cause })))
    })

    const of = Effect.fn("RecentPlaces.of")(function* (userId: UserId) {
      return fresh((yield* store.get)[userId] ?? [], yield* Clock.currentTimeMillis)
    })

    return Service.of({ record, of })
  }),
)

export * as RecentPlaces from "./RecentPlaces.ts"
