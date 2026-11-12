import { DiscordREST } from "dfx"
import { Config, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { GuildId } from "../shared/Ids.ts"
import type { Upload } from "./Discord.ts"
import { discordError } from "./DiscordError.ts"

const API = "https://discord.com/api/v10"

const MAX_ERROR_BODY = 500

const CreatedSticker = Schema.Struct({ id: Schema.String })

const CUSTOM_EMOJI = /^<?a?:?\w+:(\d{1,20})>?$/

const soundEmoji = (value: string) =>
  Option.match(Option.fromNullishOr(CUSTOM_EMOJI.exec(value)?.[1]), {
    onNone: () => ({ emoji_name: value, emoji_id: null }),
    onSome: (id) => ({ emoji_id: id, emoji_name: null }),
  })

const dataUri = (upload: Upload) => `data:${upload.contentType};base64,${Buffer.from(upload.data).toString("base64")}`

export type Kind = "emoji" | "sticker" | "sound"

export interface NewEmoji {
  readonly name: string
  readonly image: Upload
}

export interface NewSticker {
  readonly name: string
  /** The related emoji, which Discord uses for suggestions. */
  readonly emoji: string
  readonly description: Option.Option<string>
  readonly image: Upload
}

export interface NewSound {
  readonly name: string
  readonly sound: Upload
  /** A Unicode emoji, or a custom emoji as `name:id`. */
  readonly emoji: Option.Option<string>
  readonly volume: Option.Option<number>
}

export interface CreatedEmoji {
  readonly id: string
  readonly name: string
  readonly animated: boolean
}

/** A custom emoji, sticker or soundboard sound of a Discord server. */
export interface Expression {
  readonly kind: Kind
  readonly id: string
  readonly name: string
  /** How to use it: the emoji code, the sticker's emoji and description, or the sound's emoji and volume. */
  readonly detail: string
  readonly addedBy: Option.Option<string>
}

/** Fields that are not set stay as they are. `null` clears the field. */
export interface Change {
  readonly name?: string | undefined
  /** A sticker's related emoji, or a sound's emoji (Unicode, or `name:id`). */
  readonly emoji?: string | null | undefined
  readonly description?: string | null | undefined
  readonly volume?: number | undefined
}

export const make = Effect.gen(function* () {
  const rest = yield* DiscordREST
  const http = yield* HttpClient.HttpClient
  const token = yield* Config.Redacted("DISCORD_BOT_TOKEN")

  const addEmoji = Effect.fn("Discord.addEmoji")(
    function* (guildId: GuildId, emoji: NewEmoji) {
      const created = yield* rest.createGuildEmoji(guildId, { name: emoji.name, image: dataUri(emoji.image) })

      return { id: created.id, name: created.name, animated: created.animated } satisfies CreatedEmoji
    },
    (effect) => discordError("Discord.addEmoji")(effect),
  )

  // dfx sends the file as a nameless Blob, and Discord needs the file name to detect the sticker format.
  const addSticker = Effect.fn("Discord.addSticker")(
    function* (guildId: GuildId, sticker: NewSticker) {
      const form = new FormData()

      form.set("name", sticker.name)
      form.set("tags", sticker.emoji)
      form.set("description", Option.getOrElse(sticker.description, () => ""))
      form.set("file", new File([sticker.image.data], sticker.image.name, { type: sticker.image.contentType }))

      const request = HttpClientRequest.post(`${API}/guilds/${guildId}/stickers`).pipe(
        HttpClientRequest.setHeader("authorization", `Bot ${Redacted.value(token)}`),
        HttpClientRequest.bodyFormData(form),
      )

      const response = yield* http.execute(request)

      if (response.status >= 400) {
        const body = yield* response.text

        return yield* Effect.fail({ status: response.status, body: body.slice(0, MAX_ERROR_BODY) })
      }

      return (yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CreatedSticker)))).id
    },
    (effect) => discordError("Discord.addSticker")(effect),
  )

  const addSound = Effect.fn("Discord.addSound")(
    function* (guildId: GuildId, sound: NewSound) {
      const emoji = Option.map(sound.emoji, soundEmoji)

      const created = yield* rest.createGuildSoundboardSound(guildId, {
        name: sound.name,
        sound: dataUri(sound.sound),
        volume: Option.getOrUndefined(sound.volume),
        ...Option.getOrElse(emoji, () => ({})),
      })

      return created.sound_id
    },
    (effect) => discordError("Discord.addSound")(effect),
  )

  const listExpressions = Effect.fn("Discord.listExpressions")(
    function* (guildId: GuildId) {
      const [emojis, stickers, sounds] = yield* Effect.all(
        [rest.listGuildEmojis(guildId), rest.listGuildStickers(guildId), rest.listGuildSoundboardSounds(guildId)],
        { concurrency: "unbounded" },
      )

      const addedBy = (user: { readonly username: string; readonly global_name?: string | null | undefined } | undefined) =>
        Option.fromUndefinedOr(user).pipe(Option.map((value) => value.global_name ?? value.username))

      return [
        ...(emojis ?? []).map(
          (emoji): Expression => ({
            kind: "emoji",
            id: emoji.id,
            name: emoji.name,
            detail: `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`,
            addedBy: addedBy(emoji.user),
          }),
        ),
        ...stickers.map(
          (sticker): Expression => ({
            kind: "sticker",
            id: sticker.id,
            name: sticker.name,
            detail: [sticker.tags, sticker.description ?? ""].filter((part) => part !== "").join(" — "),
            addedBy: addedBy(sticker.user),
          }),
        ),
        ...sounds.items.map(
          (sound): Expression => ({
            kind: "sound",
            id: sound.sound_id,
            name: sound.name,
            detail: [
              sound.emoji_name ?? (sound.emoji_id === null ? "" : `emoji ${sound.emoji_id}`),
              `volume ${sound.volume}`,
            ]
              .filter((part) => part !== "")
              .join(", "),
            addedBy: addedBy(sound.user),
          }),
        ),
      ]
    },
    (effect) => discordError("Discord.listExpressions")(effect),
  )

  const updateExpression = Effect.fn("Discord.updateExpression")(
    function* (guildId: GuildId, kind: Kind, id: string, change: Change) {
      switch (kind) {
        case "emoji":
          return yield* rest.updateGuildEmoji(guildId, id, { name: change.name }).pipe(Effect.asVoid)
        case "sticker":
          return yield* rest
            .updateGuildSticker(guildId, id, {
              name: change.name,
              tags: change.emoji ?? undefined,
              description: change.description,
            })
            .pipe(Effect.asVoid)
        case "sound": {
          const emoji =
            change.emoji === undefined
              ? { emoji_id: undefined, emoji_name: undefined }
              : change.emoji === null
                ? { emoji_id: null, emoji_name: null }
                : soundEmoji(change.emoji)

          return yield* rest
            .updateGuildSoundboardSound(guildId, id, {
              name: change.name,
              volume: change.volume,
              emoji_id: emoji.emoji_id,
              emoji_name: emoji.emoji_name,
            })
            .pipe(Effect.asVoid)
        }
      }
    },
    (effect) => discordError("Discord.updateExpression")(effect),
  )

  const removeExpression = Effect.fn("Discord.removeExpression")(
    function* (guildId: GuildId, kind: Kind, id: string) {
      switch (kind) {
        case "emoji":
          return yield* rest.deleteGuildEmoji(guildId, id)
        case "sticker":
          return yield* rest.deleteGuildSticker(guildId, id)
        case "sound":
          return yield* rest.deleteGuildSoundboardSound(guildId, id)
      }
    },
    (effect) => discordError("Discord.removeExpression")(effect),
  )

  return { addEmoji, addSticker, addSound, listExpressions, updateExpression, removeExpression }
})

export * as Expressions from "./Expressions.ts"
