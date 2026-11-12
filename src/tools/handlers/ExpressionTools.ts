import { Effect, Option } from "effect"
import { Discord } from "../../discord/Discord.ts"
import type { Expressions } from "../../discord/Expressions.ts"
import { Files } from "../../shared/Files.ts"
import type { GuildId } from "../../shared/Ids.ts"
import { ToolCalls } from "../ToolCalls.ts"
import { Uploads } from "../Uploads.ts"

const KB = 1024

const limits: Record<ToolCalls.ExpressionKind, { readonly bytes: number; readonly types: ReadonlySet<string>; readonly formats: string }> = {
  emoji: { bytes: 256 * KB, types: new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]), formats: "PNG, JPEG, GIF or WebP" },
  sticker: { bytes: 512 * KB, types: new Set(["image/png", "image/gif"]), formats: "PNG, APNG or GIF" },
  sound: { bytes: 512 * KB, types: new Set(["audio/mpeg", "audio/ogg"]), formats: "MP3 or OGG" },
}

const EMOJI_NAME = /^\w{2,32}$/

const CUSTOM_ID = /^<?a?:?\w*:(\d{1,20})>?$/

const MAX_STICKER_NAME = 30

const PERMISSION_HINTS = {
  add: 'Wendell needs the "Create Expressions" permission in this Discord server. Ask an admin to give it to his role.',
  change:
    'Wendell can change only the emojis, stickers and sounds that he added. For the others, he needs the "Manage Expressions" ' +
    "permission. Ask an admin to give it to his role.",
} as const

const refused = (kind: ToolCalls.ExpressionKind, action: keyof typeof PERMISSION_HINTS) => (error: Discord.DiscordError) => {
  const detail = JSON.stringify(error.cause) ?? ""

  if (detail.includes("50013") || detail.includes("Missing Permissions")) {
    return new ToolCalls.ToolFailure({ message: PERMISSION_HINTS[action] })
  }

  if (detail.includes("Ratelimited")) return new ToolCalls.ToolFailure({ message: `Discord rate-limited the ${kind} change. Try later.` })

  if (detail.includes("10014") || detail.includes("10060") || detail.includes("10097")) {
    return new ToolCalls.ToolFailure({ message: `That ${kind} does not exist in this Discord server.` })
  }

  return new ToolCalls.ToolFailure({ message: `Discord refused the ${kind} change: ${detail.slice(0, 400)}` })
}

const describe = (expression: Expressions.Expression) =>
  [
    `- ${expression.kind} "${expression.name}" (ID ${expression.id})`,
    expression.detail === "" ? "" : `: ${expression.detail}`,
    Option.match(expression.addedBy, { onNone: () => "", onSome: (name) => `, added by ${name}` }),
  ].join("")

/**
 * `wendell_add_expression`, `wendell_list_expressions`, `wendell_edit_expression` and `wendell_remove_expression`.
 * Files are read from the server with the same path rules as reply files.
 */
export const make = Effect.gen(function* () {
  const discord = yield* Discord.Service
  const uploads = yield* Uploads.Service

  const guildOf = Effect.fn("ExpressionTools.guildOf")(function* (target: ToolCalls.Target) {
    const info = yield* discord.channel(target.channelId).pipe(Effect.mapError(ToolCalls.failure("Could not read this channel.")))

    if (Option.isNone(info.guildId)) return yield* ToolCalls.fail("Emojis, stickers and sounds exist only in Discord servers, not in DMs.")

    return info.guildId.value
  })

  const checkName = Effect.fn("ExpressionTools.checkName")(function* (kind: ToolCalls.ExpressionKind, name: string) {
    if (kind === "emoji" && !EMOJI_NAME.test(name)) {
      return yield* ToolCalls.fail("Emoji names may use only letters, digits and underscores (2 to 32 characters).")
    }

    if (kind === "sticker" && name.length > MAX_STICKER_NAME) {
      return yield* ToolCalls.fail(`Sticker names have at most ${MAX_STICKER_NAME} characters.`)
    }
  })

  /** Finds one expression of `kind` by its ID, or else by its exact name (case-insensitive). */
  const find = Effect.fn("ExpressionTools.find")(function* (
    guildId: GuildId,
    kind: ToolCalls.ExpressionKind,
    wanted: string,
  ) {
    const all = yield* discord.listExpressions(guildId).pipe(Effect.mapError(refused(kind, "change")))
    const ofKind = all.filter((expression) => expression.kind === kind)
    const id = CUSTOM_ID.exec(wanted)?.[1] ?? wanted
    const byId = ofKind.find((expression) => expression.id === id)

    if (byId !== undefined) return byId

    const name = wanted.replaceAll(":", "").toLowerCase()
    const byName = ofKind.filter((expression) => expression.name.toLowerCase() === name)

    if (byName.length === 1 && byName[0] !== undefined) return byName[0]

    if (byName.length > 1) {
      return yield* ToolCalls.fail(`More than one ${kind} has this name. Use the ID:\n${byName.map(describe).join("\n")}`)
    }

    return yield* ToolCalls.fail(`No ${kind} "${wanted}" exists in this Discord server. Call list_expressions to see them.`)
  })

  const add = Effect.fn("ExpressionTools.add")(function* (target: ToolCalls.Target, call: ToolCalls.CallOf<"AddExpression">) {
    const { kind, name, file } = call
    const limit = limits[kind]

    yield* checkName(kind, name)

    if (kind === "sticker" && Option.isNone(call.emoji)) return yield* ToolCalls.fail("A sticker needs a related emoji in `emoji`.")

    const guildId = yield* guildOf(target)

    const [upload] = yield* uploads
      .load(target.remote, target.channelId, [file])
      .pipe(Effect.mapError((error) => new ToolCalls.ToolFailure({ message: error.message })))

    if (upload === undefined) return yield* ToolCalls.fail(`Could not read ${file}.`)

    if (!limit.types.has(upload.contentType)) return yield* ToolCalls.fail(`A ${kind} must be ${limit.formats}. ${file} is not.`)

    if (upload.data.byteLength > limit.bytes) {
      return yield* ToolCalls.fail(
        `${file} is ${Files.formatSize(upload.data.byteLength)}. A ${kind} may be at most ${Files.formatSize(limit.bytes)}. ` +
          "Make it smaller and try again.",
      )
    }

    const result = yield* Effect.gen(function* () {
      switch (kind) {
        case "emoji": {
          const emoji = yield* discord.addEmoji(guildId, { name, image: upload })
          const code = `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`

          return `Added the emoji ${code}. Write ${code} in a message to use it, or react with ${emoji.name}:${emoji.id}.`
        }

        case "sticker": {
          const id = yield* discord.addSticker(guildId, {
            name,
            emoji: Option.getOrElse(call.emoji, () => ""),
            description: call.description,
            image: upload,
          })

          return `Added the sticker "${name}" (ID ${id}).`
        }

        case "sound": {
          const id = yield* discord.addSound(guildId, { name, sound: upload, emoji: call.emoji, volume: call.volume })

          return `Added the soundboard sound "${name}" (ID ${id}).`
        }
      }
    }).pipe(Effect.mapError(refused(kind, "add")))

    yield* Effect.logInfo("Added an expression", { kind, guildId })

    return result
  })

  const list = Effect.fn("ExpressionTools.list")(function* (target: ToolCalls.Target, { kind }: ToolCalls.CallOf<"ListExpressions">) {
    const guildId = yield* guildOf(target)

    const all = yield* discord
      .listExpressions(guildId)
      .pipe(Effect.mapError(ToolCalls.failure("Could not read the emojis, stickers and sounds of this Discord server.")))

    const shown = Option.match(kind, { onNone: () => all, onSome: (wanted) => all.filter((expression) => expression.kind === wanted) })

    if (shown.length === 0) return `This Discord server has no ${Option.match(kind, { onNone: () => "custom emojis, stickers or sounds", onSome: (value) => `${value}s` })}.`

    return shown.map(describe).join("\n")
  })

  const edit = Effect.fn("ExpressionTools.edit")(function* (
    target: ToolCalls.Target,
    { kind, expression, change }: ToolCalls.CallOf<"EditExpression">,
  ) {
    const changed = Object.entries(change).flatMap(([field, value]) => (value === undefined ? [] : [field]))

    if (changed.length === 0) return yield* ToolCalls.fail("Set at least one field to change.")

    if (change.name !== undefined) yield* checkName(kind, change.name)

    if (kind === "emoji" && changed.some((field) => field !== "name")) return yield* ToolCalls.fail("For an emoji, only the name can change.")

    if (kind === "sticker" && (change.volume !== undefined || change.emoji === null)) {
      return yield* ToolCalls.fail("For a sticker, change name, emoji or description. A sticker always has an emoji.")
    }

    if (kind === "sound" && change.description !== undefined) return yield* ToolCalls.fail("Sounds have no description.")

    const guildId = yield* guildOf(target)
    const found = yield* find(guildId, kind, expression)

    yield* discord.updateExpression(guildId, kind, found.id, change).pipe(Effect.mapError(refused(kind, "change")))
    yield* Effect.logInfo("Changed an expression", { kind, guildId, fields: changed })

    return `Changed the ${kind} "${found.name}" (ID ${found.id}): ${changed.join(", ")}.`
  })

  const remove = Effect.fn("ExpressionTools.remove")(function* (
    target: ToolCalls.Target,
    { kind, expression }: ToolCalls.CallOf<"RemoveExpression">,
  ) {
    const guildId = yield* guildOf(target)
    const found = yield* find(guildId, kind, expression)

    yield* discord.removeExpression(guildId, kind, found.id).pipe(Effect.mapError(refused(kind, "change")))
    yield* Effect.logInfo("Removed an expression", { kind, guildId })

    return `Removed the ${kind} "${found.name}" (ID ${found.id}).`
  })

  return { add, list, edit, remove }
})

export * as ExpressionTools from "./ExpressionTools.ts"
