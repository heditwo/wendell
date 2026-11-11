import type { Discord as DiscordTypes } from "dfx"
import { Option, Schema } from "effect"
import type { Inbound } from "../inbound/Inbound.ts"
import { ChannelId, GuildId, MessageId, UserId } from "../shared/Ids.ts"
import type { ButtonPress, ChannelInfo, CommandCall } from "./Discord.ts"

const MESSAGE_TYPE_DEFAULT = 0
const MESSAGE_TYPE_REPLY = 19
export const INTERACTION_APPLICATION_COMMAND = 2
const INTERACTION_MESSAGE_COMPONENT = 3
export const INTERACTION_AUTOCOMPLETE = 4
const COMMAND_CHAT_INPUT = 1
export const OPTION_STRING = 3
const COMPONENT_BUTTON = 2

const isThreadChannel = (channel: DiscordTypes.APIChannel): channel is DiscordTypes.APIThreadChannel =>
  channel.type === 10 || channel.type === 11 || channel.type === 12

export const describeChannel = (channel: DiscordTypes.APIChannel): ChannelInfo => {
  const guildId = "guild_id" in channel ? Option.fromNullishOr(channel.guild_id).pipe(Option.map(GuildId.make)) : Option.none()

  return isThreadChannel(channel)
    ? { isThread: true, parentId: Option.fromNullishOr(channel.parent_id).pipe(Option.map(ChannelId.make)), guildId }
    : { isThread: false, parentId: Option.none(), guildId }
}

export const displayName = (user: DiscordTypes.UserResponse) => user.global_name ?? user.username

const SnapshotAttachment = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  url: Schema.String,
  content_type: Schema.optional(Schema.String),
  size: Schema.Number,
})

// dfx's types do not include forwarded messages yet, so this part of the payload is decoded on its own.
const Forwards = Schema.Struct({
  message_snapshots: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.Struct({
          content: Schema.optional(Schema.String),
          attachments: Schema.optional(Schema.Array(SnapshotAttachment)),
        }),
      }),
    ),
  ),
})

const forwardsOf = (data: DiscordTypes.GatewayMessageCreateDispatchData) =>
  Option.match(Schema.decodeUnknownOption(Forwards)(data), {
    onNone: () => [],
    onSome: (decoded) => (decoded.message_snapshots ?? []).map((snapshot) => snapshot.message),
  })

const toAttachment = (attachment: {
  readonly id: string
  readonly filename: string
  readonly url: string
  readonly content_type?: string | null | undefined
  readonly size: number
}): Inbound.Attachment => ({
  id: attachment.id,
  name: attachment.filename,
  url: attachment.url,
  contentType: Option.fromNullishOr(attachment.content_type),
  size: attachment.size,
})

export const toInbound = (me: UserId, data: DiscordTypes.GatewayMessageCreateDispatchData): Inbound.Message => ({
  id: MessageId.make(data.id),
  channelId: ChannelId.make(data.channel_id),
  guildId: Option.fromNullishOr(data.guild_id).pipe(Option.map(GuildId.make)),
  authorId: UserId.make(data.author.id),
  authorName: data.member?.nick ?? displayName(data.author),
  authorIsBot: data.author.bot === true || data.author.id === me,
  content: data.content,
  forwarded: Option.some(
    forwardsOf(data)
      .flatMap((forward) => Option.toArray(Option.fromNullishOr(forward.content)))
      .filter((text) => text.trim() !== "")
      .join("\n\n"),
  ).pipe(Option.filter((text) => text !== "")),
  attachments: [
    ...data.attachments.map(toAttachment),
    ...forwardsOf(data).flatMap((forward) => (forward.attachments ?? []).map(toAttachment)),
  ],
  stickers: (data.sticker_items ?? []).map((sticker) => sticker.name),
  transcript: Option.none(),
  mentionsMe: data.mentions.some((user) => user.id === me),
  repliesToMe: data.referenced_message?.author.id === me,
})

const hasSubstance = (data: DiscordTypes.GatewayMessageCreateDispatchData) =>
  data.content.trim() !== "" ||
  data.attachments.length > 0 ||
  (data.sticker_items ?? []).length > 0 ||
  forwardsOf(data).some((forward) => (forward.content ?? "").trim() !== "" || (forward.attachments ?? []).length > 0)

/** Messages that people write, as opposed to joins, pins and other system messages. */
export const isConversational = (data: DiscordTypes.GatewayMessageCreateDispatchData) =>
  (data.type === MESSAGE_TYPE_DEFAULT || data.type === MESSAGE_TYPE_REPLY) && hasSubstance(data)

export const toButtonPress = (interaction: DiscordTypes.APIInteraction): Option.Option<ButtonPress> => {
  if (interaction.type !== INTERACTION_MESSAGE_COMPONENT) return Option.none()

  if (interaction.data.component_type !== COMPONENT_BUTTON) return Option.none()

  const user = interaction.member?.user ?? interaction.user

  if (user === undefined || interaction.channel === undefined) return Option.none()

  return Option.some({
    interactionId: interaction.id,
    token: interaction.token,
    customId: interaction.data.custom_id,
    channelId: ChannelId.make(interaction.channel.id),
    member: {
      userId: UserId.make(user.id),
      guildId: Option.fromNullishOr(interaction.guild_id).pipe(Option.map(GuildId.make)),
    },
  })
}

export const toCommandCall = (interaction: DiscordTypes.APIInteraction, wanted: number): Option.Option<CommandCall> => {
  if (interaction.type !== wanted) return Option.none()

  if (interaction.type !== INTERACTION_APPLICATION_COMMAND && interaction.type !== INTERACTION_AUTOCOMPLETE) return Option.none()

  if (interaction.data.type !== COMMAND_CHAT_INPUT) return Option.none()

  const user = interaction.member?.user ?? interaction.user

  if (user === undefined || interaction.channel === undefined) return Option.none()

  const options = (interaction.data.options ?? []).flatMap((option) =>
    option.type === OPTION_STRING
      ? [{ name: option.name, value: option.value, focused: "focused" in option && option.focused === true }]
      : [],
  )

  return Option.some({
    interactionId: interaction.id,
    token: interaction.token,
    applicationId: interaction.application_id,
    name: interaction.data.name,
    options,
    channelId: ChannelId.make(interaction.channel.id),
    userName: interaction.member?.nick ?? user.global_name ?? user.username,
    member: {
      userId: UserId.make(user.id),
      guildId: Option.fromNullishOr(interaction.guild_id).pipe(Option.map(GuildId.make)),
    },
  })
}

export * as Payloads from "./Payloads.ts"
