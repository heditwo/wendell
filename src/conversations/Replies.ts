import { Context, Effect, Layer, type Option, Schema } from "effect"
import type { Discord } from "../discord/Discord.ts"
import type { Embeds } from "../discord/Embeds.ts"
import type { Fleet } from "../opencode/Fleet.ts"
import type { ChannelId, MessageId, ServerName, UserId } from "../shared/Ids.ts"
import type { Source } from "./Conversation.ts"

export interface Reply {
  readonly text: string
  readonly replyTo: Option.Option<MessageId>
  readonly files: ReadonlyArray<Discord.Upload>
  readonly embeds: ReadonlyArray<Embeds.Embed>
  readonly mention: Option.Option<UserId>
  /** True: also say it in the voice call. False: do not say it. None: decide from the newest input. */
  readonly speak: Option.Option<boolean>
}

export interface Sent {
  readonly spoken: boolean
  /** None when the reply was spoken and the text post failed. */
  readonly posted: Option.Option<{ readonly channelId: ChannelId; readonly messageId: MessageId }>
}

/** The message goes back to the agent. */
export class ReplyError extends Schema.TaggedError<ReplyError>()("Replies.ReplyError", {
  message: Schema.String,
}) {}

export interface Interface {
  /** Records where the newest input of a conversation came from. */
  readonly arrived: (server: ServerName, channelId: ChannelId, source: Source) => Effect.Effect<void>
  /** Sends Wendell's reply for the conversation of `channelId`: as text, as speech in its voice call, or both. */
  readonly send: (remote: Fleet.Remote, channelId: ChannelId, reply: Reply) => Effect.Effect<Sent, ReplyError>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Replies") {}

export const layer: Layer.Layer<Service> = Layer.effect(Service, Effect.die("Replies.layer is not implemented yet"))

export * as Replies from "./Replies.ts"
