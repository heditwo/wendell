import { Effect, Option } from "effect"
import { Activity } from "../../conversations/Activity.ts"
import { Replies } from "../../conversations/Replies.ts"
import { Discord } from "../../discord/Discord.ts"
import { Embeds } from "../../discord/Embeds.ts"
import { Recent } from "../../inbound/Recent.ts"
import { Calls } from "../../voice/Calls.ts"
import { ToolCalls } from "../ToolCalls.ts"
import { Uploads } from "../Uploads.ts"

export const make = Effect.gen(function* () {
  const discord = yield* Discord.Service
  const activity = yield* Activity.Service
  const uploads = yield* Uploads.Service
  const replies = yield* Replies.Service
  const recent = yield* Recent.Service
  const calls = yield* Calls.Service

  const reply = Effect.fn("ReplyTools.reply")(function* (
    { remote, channelId }: ToolCalls.Target,
    { text, replyTo, files, embeds, mention, speak, post }: ToolCalls.CallOf<"Reply">,
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

    const sent = yield* replies
      .send(remote, channelId, { text, replyTo, files: attached, embeds, mention, speak, post })
      .pipe(Effect.mapError((error) => new ToolCalls.ToolFailure({ message: error.message })))

    const withFiles = attached.length === 0 ? "" : ` with ${attached.map((upload) => upload.name).join(", ")}`

    if (Option.isNone(sent.posted)) {
      return sent.postFailed
        ? "Spoken in the voice call. The text could not be posted."
        : "Spoken in the voice call. Not posted as text: set post: true only when a person asks for the text."
    }

    const { channelId: postedIn, messageId } = sent.posted.value

    const done = sent.spoken
      ? `Spoken in the voice call and posted in <#${postedIn}> as message ${messageId}${withFiles}.`
      : postedIn === channelId
        ? `Posted message ${messageId}${withFiles}.`
        : `Posted in <#${postedIn}> as message ${messageId}${withFiles}.`

    if (sent.spoken || Option.contains(speak, false)) return done

    if (Option.contains(speak, true)) {
      return `${done} Not spoken: nothing in the text can be read aloud, or the call has ended.`
    }

    return Option.isSome(yield* calls.ofHome(remote.name, channelId)) ? `${done} Not spoken. Set speak: true to say it in the call.` : done
  })

  const react = Effect.fn("ReplyTools.react")(function* (
    { remote, channelId }: ToolCalls.Target,
    { messageId, emoji }: ToolCalls.CallOf<"React">,
  ) {
    const message = yield* recent.get(messageId)
    const call = yield* calls.ofHome(remote.name, channelId)

    const where = Option.match(message, {
      onNone: () => channelId,
      onSome: (found) => (Option.exists(call, ({ channelId: voiceChat }) => voiceChat === found.channelId) ? found.channelId : channelId),
    })

    yield* discord.react(where, messageId, emoji).pipe(Effect.mapError(ToolCalls.failure("Could not add the reaction.")))
    yield* activity.spoke(channelId)

    return "Reacted."
  })

  return { reply, react }
})

export * as ReplyTools from "./ReplyTools.ts"
