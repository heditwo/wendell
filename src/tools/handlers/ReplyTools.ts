import { Effect, Option } from "effect"
import { Activity } from "../../conversations/Activity.ts"
import { Discord } from "../../discord/Discord.ts"
import { Embeds } from "../../discord/Embeds.ts"
import { ToolCalls } from "../ToolCalls.ts"
import { Uploads } from "../Uploads.ts"

export const make = Effect.gen(function* () {
  const discord = yield* Discord.Service
  const activity = yield* Activity.Service
  const uploads = yield* Uploads.Service

  const reply = Effect.fn("ReplyTools.reply")(function* (
    { remote, channelId }: ToolCalls.Target,
    { text, replyTo, files, embeds, mention }: ToolCalls.CallOf<"Reply">,
  ) {
    const attached =
      files.length === 0
        ? []
        : yield* uploads
            .load(remote, channelId, files)
            .pipe(Effect.mapError((error) => new ToolCalls.ToolFailure({ message: error.message })))

    const names = new Set(attached.map((upload) => upload.name))
    const missing = Embeds.attachmentNames(embeds).filter((name) => !names.has(name))

    if (missing.length > 0) {
      return yield* ToolCalls.fail(
        `The embeds use attachment://${missing.join(", attachment://")}, but the attached files are named: ` +
          `${[...names].join(", ") || "(none)"}.`,
      )
    }

    const content = Option.match(mention, {
      onNone: () => text,
      onSome: (userId) => (text.includes(`<@${userId}>`) ? text : `<@${userId}> ${text}`),
    })

    const messageId = yield* discord.post(channelId, { text: content, replyTo, files: attached, embeds, mention }).pipe(
      Effect.tapError((error) => Effect.logWarning("Could not post a reply", { channelId, cause: error.cause })),
      Effect.mapError(
        ToolCalls.failure(
          attached.length === 0
            ? "Could not post the message."
            : "Could not post the message. The files may be too large for this Discord server.",
        ),
      ),
    )

    yield* activity.spoke(channelId)

    return `Posted message ${messageId}${attached.length === 0 ? "" : ` with ${attached.map((upload) => upload.name).join(", ")}`}.`
  })

  const react = Effect.fn("ReplyTools.react")(function* (
    { channelId }: ToolCalls.Target,
    { messageId, emoji }: ToolCalls.CallOf<"React">,
  ) {
    yield* discord.react(channelId, messageId, emoji).pipe(Effect.mapError(ToolCalls.failure("Could not add the reaction.")))
    yield* activity.spoke(channelId)

    return "Reacted."
  })

  return { reply, react }
})

export * as ReplyTools from "./ReplyTools.ts"
