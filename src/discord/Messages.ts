import { DiscordREST, type Discord as DiscordTypes } from "dfx"
import { Config, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ChannelId, MessageId, UserId } from "../shared/Ids.ts"
import { truncate } from "../shared/Text.ts"
import type { Button, Outgoing, TranscriptLine, Upload } from "./Discord.ts"
import { discordError } from "./DiscordError.ts"
import { displayName } from "./Payloads.ts"

export const MAX_MESSAGE_LENGTH = 2000
const MAX_THREAD_NAME = 100
const ONE_WEEK_MINUTES = 10_080
const PUBLIC_THREAD = 11

const API = "https://discord.com/api/v10"

const SentMessage = Schema.Struct({ id: Schema.String })

const buttonStyles = { primary: 1, secondary: 2, success: 3, danger: 4 } as const

export const make = (me: UserId) =>
  Effect.gen(function* () {
    const rest = yield* DiscordREST
    const http = yield* HttpClient.HttpClient
    const token = yield* Config.Redacted("DISCORD_BOT_TOKEN")

    const transcript = Effect.fn("Discord.transcript")(
      function* (channelId: ChannelId, before: Option.Option<MessageId>, limit: number) {
        const page = yield* rest.listMessages(channelId, { before: Option.getOrUndefined(before), limit })

        return (page ?? []).toReversed().map(
          (message): TranscriptLine => ({
            id: MessageId.make(message.id),
            authorId: UserId.make(message.author.id),
            authorName: displayName(message.author),
            isMe: message.author.id === me,
            isBot: message.author.id !== me && (message.author.bot === true || message.webhook_id !== undefined),
            content: [message.content, ...message.attachments.map((attachment) => `[attachment: ${attachment.filename}]`)]
              .filter((part) => part.trim() !== "")
              .join(" "),
          }),
        )
      },
      (effect) => discordError("Discord.transcript")(effect),
    )

    const send = Effect.fn("Discord.send")(
      function* (channelId: ChannelId, text: string, replyTo: Option.Option<MessageId>, buttons: ReadonlyArray<Button> = []) {
        const message = yield* rest.createMessage(channelId, {
          content: truncate(text, MAX_MESSAGE_LENGTH),
          allowed_mentions: { parse: [] },
          message_reference: Option.match(replyTo, {
            onNone: () => undefined,
            onSome: (messageId) => ({ message_id: messageId, fail_if_not_exists: false }),
          }),
          components:
            buttons.length === 0
              ? undefined
              : [
                  {
                    type: 1,
                    components: buttons.map((button) => ({
                      type: 2,
                      custom_id: button.id,
                      label: button.label,
                      style: buttonStyles[button.style],
                    })),
                  },
                ],
        })

        return MessageId.make(message.id)
      },
      (effect) => discordError("Discord.send")(effect),
    )

    // dfx sends `payload_json` as a nameless Blob, which Bun turns into a file, so Discord ignores the message
    // fields. Uploads therefore go through a plain multipart request.
    const upload = Effect.fn("Discord.upload")(function* (
      channelId: ChannelId,
      payload: DiscordTypes.MessageCreateRequest,
      files: ReadonlyArray<Upload>,
    ) {
      const form = new FormData()

      form.set("payload_json", JSON.stringify(payload))
      files.forEach((file, index) => form.append(`files[${index}]`, new File([file.data], file.name, { type: file.contentType })))

      const request = HttpClientRequest.post(`${API}/channels/${channelId}/messages`).pipe(
        HttpClientRequest.setHeader("authorization", `Bot ${Redacted.value(token)}`),
        HttpClientRequest.bodyFormData(form),
      )

      const response = yield* http.execute(request).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))

      return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SentMessage)))
    })

    const post = Effect.fn("Discord.post")(
      function* (channelId: ChannelId, message: Outgoing) {
        const payload: DiscordTypes.MessageCreateRequest = {
          content: message.text === "" ? undefined : truncate(message.text, MAX_MESSAGE_LENGTH),
          allowed_mentions: Option.match(message.mention, {
            onNone: () => ({ parse: [] }),
            onSome: (userId) => ({ parse: [], users: [userId] }),
          }),
          message_reference: Option.match(message.replyTo, {
            onNone: () => undefined,
            onSome: (messageId) => ({ message_id: messageId, fail_if_not_exists: false }),
          }),
          embeds: message.embeds.length === 0 ? undefined : message.embeds,
          attachments:
            message.files.length === 0 ? undefined : message.files.map((file, index) => ({ id: String(index), filename: file.name })),
        }

        const sent = yield* message.files.length === 0 ? rest.createMessage(channelId, payload) : upload(channelId, payload, message.files)

        return MessageId.make(sent.id)
      },
      (effect) => discordError("Discord.post")(effect),
    )

    const edit = Effect.fn("Discord.edit")(
      function* (channelId: ChannelId, messageId: MessageId, text: string) {
        yield* rest.updateMessage(channelId, messageId, { content: truncate(text, MAX_MESSAGE_LENGTH) })
      },
      (effect) => discordError("Discord.edit")(effect),
    )

    const remove = Effect.fn("Discord.remove")(
      function* (channelId: ChannelId, messageId: MessageId) {
        yield* rest.deleteMessage(channelId, messageId)
      },
      (effect) => discordError("Discord.remove")(effect),
    )

    const react = Effect.fn("Discord.react")(
      function* (channelId: ChannelId, messageId: MessageId, emoji: string) {
        yield* rest.addMyMessageReaction(channelId, messageId, encodeURIComponent(emoji))
      },
      (effect) => discordError("Discord.react")(effect),
    )

    const unreact = Effect.fn("Discord.unreact")(
      function* (channelId: ChannelId, messageId: MessageId, emoji: string) {
        yield* rest.deleteMyMessageReaction(channelId, messageId, encodeURIComponent(emoji))
      },
      (effect) => discordError("Discord.unreact")(effect),
    )

    const typing = Effect.fn("Discord.typing")(
      function* (channelId: ChannelId) {
        yield* rest.triggerTypingIndicator(channelId)
      },
      (effect) => discordError("Discord.typing")(effect),
    )

    const startThread = Effect.fn("Discord.startThread")(
      function* (channelId: ChannelId, messageId: MessageId, name: string) {
        const thread = yield* rest.createThreadFromMessage(channelId, messageId, {
          name: truncate(name, MAX_THREAD_NAME),
          auto_archive_duration: ONE_WEEK_MINUTES,
        })

        return ChannelId.make(thread.id)
      },
      (effect) => discordError("Discord.startThread")(effect),
    )

    const createThread = Effect.fn("Discord.createThread")(
      function* (channelId: ChannelId, name: string) {
        const thread = yield* rest.createThread(channelId, {
          name: truncate(name, MAX_THREAD_NAME),
          type: PUBLIC_THREAD,
          auto_archive_duration: ONE_WEEK_MINUTES,
        })

        return ChannelId.make(thread.id)
      },
      (effect) => discordError("Discord.createThread")(effect),
    )

    return { transcript, send, post, edit, remove, react, unreact, typing, startThread, createThread }
  })

export * as Messages from "./Messages.ts"
