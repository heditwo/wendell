import type { AbsolutePath } from "@opencode/client/effect"
import { Effect, type Option, Schema } from "effect"
import type { WendellConfig } from "../config/WendellConfig.ts"
import type { Fleet } from "../opencode/Fleet.ts"
import type { ChannelId, GuildId, MessageId } from "../shared/Ids.ts"

export type Kind = "channel" | "task" | "dm"

/** Where a Discord conversation lives on an OpenCode server. Each one has one session. */
export interface Conversation {
  readonly kind: Kind
  readonly channelId: ChannelId
  readonly guildId: Option.Option<GuildId>
  readonly remote: Fleet.Remote
  readonly directory: AbsolutePath
  readonly title: string
}

/** How Wendell shows and finishes one turn. */
export interface Turn {
  /** Someone is waiting: never end in silence. */
  readonly expectReply: boolean
  /** Show 👀, typing and a live status line while Wendell works. */
  readonly progress: boolean
  /** Without `progress`: show them from the first tool call, when Wendell has decided to act. */
  readonly lazyProgress?: boolean | undefined
  readonly trigger: Option.Option<{ readonly channelId: ChannelId; readonly messageId: MessageId }>
  /** How to deliver while a turn is running. Default: `wait`, for Wendell's own hand-offs and reports. */
  readonly busy?: WendellConfig.BusyMode | undefined
}

export class ConversationError extends Schema.TaggedError<ConversationError>()("Conversations.ConversationError", {
  operation: Schema.String,
  server: Schema.String,
  channelId: Schema.String,
  cause: Schema.Defect(),
}) {}

export const conversationError =
  (operation: string, conversation: Conversation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(
      effect,
      (cause) =>
        new ConversationError({ operation, server: conversation.remote.name, channelId: conversation.channelId, cause }),
    )
