import { BunHttpClient, BunSocket } from "@effect/platform-bun"
import { DiscordConfig, DiscordREST, Discord as DiscordTypes, Intents } from "dfx"
import { DiscordGateway, DiscordLive } from "dfx/gateway"
import { Cache, Config, Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { ChannelId, GuildId, MessageId, UserId } from "./Ids.ts"
import type { Inbound } from "./Inbound.ts"

export const ChannelInfo = Schema.Struct({
  isThread: Schema.Boolean,
  parentId: Schema.Option(ChannelId),
  guildId: Schema.Option(GuildId),
})

export interface ChannelInfo extends Schema.Schema.Type<typeof ChannelInfo> {}

export interface GuildInfo {
  readonly ownerId: string
  readonly administratorRoles: ReadonlySet<string>
}

export interface TranscriptLine {
  readonly id: MessageId
  readonly authorName: string
  readonly isMe: boolean
  readonly content: string
}

export interface Button {
  readonly id: string
  readonly label: string
  readonly style: "primary" | "secondary" | "success" | "danger"
}

export interface ButtonPress {
  readonly interactionId: string
  readonly token: string
  readonly customId: string
  readonly channelId: ChannelId
  readonly member: {
    readonly userId: UserId
    readonly guildId: Option.Option<GuildId>
    readonly roles: ReadonlyArray<string>
  }
}

export class DiscordError extends Schema.TaggedError<DiscordError>()("Discord.DiscordError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly me: UserId
  readonly messages: Stream.Stream<Inbound.Message>
  readonly buttonPresses: Stream.Stream<ButtonPress>
  readonly channel: (channelId: ChannelId) => Effect.Effect<ChannelInfo, DiscordError>
  readonly guild: (guildId: GuildId) => Effect.Effect<GuildInfo, DiscordError>
  readonly transcript: (
    channelId: ChannelId,
    before: Option.Option<MessageId>,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<TranscriptLine>, DiscordError>
  readonly send: (
    channelId: ChannelId,
    text: string,
    replyTo: Option.Option<MessageId>,
    buttons?: ReadonlyArray<Button>,
  ) => Effect.Effect<MessageId, DiscordError>
  readonly edit: (channelId: ChannelId, messageId: MessageId, text: string) => Effect.Effect<void, DiscordError>
  readonly remove: (channelId: ChannelId, messageId: MessageId) => Effect.Effect<void, DiscordError>
  readonly react: (channelId: ChannelId, messageId: MessageId, emoji: string) => Effect.Effect<void, DiscordError>
  readonly unreact: (channelId: ChannelId, messageId: MessageId, emoji: string) => Effect.Effect<void, DiscordError>
  readonly typing: (channelId: ChannelId) => Effect.Effect<void, DiscordError>
  readonly startThread: (
    channelId: ChannelId,
    messageId: MessageId,
    name: string,
  ) => Effect.Effect<ChannelId, DiscordError>
  /** Replaces the pressed message's text and removes its buttons. */
  readonly answerPress: (press: ButtonPress, text: string) => Effect.Effect<void, DiscordError>
  /** Answers only the person who pressed, and keeps the buttons. */
  readonly answerPressPrivately: (press: ButtonPress, text: string) => Effect.Effect<void, DiscordError>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Discord") {}

const MESSAGE_TYPE_DEFAULT = 0
const MESSAGE_TYPE_REPLY = 19
const MAX_MESSAGE_LENGTH = 2000
const MAX_THREAD_NAME = 100
const ONE_WEEK_MINUTES = 10_080
const ADMINISTRATOR = 1n << 3n
const INTERACTION_MESSAGE_COMPONENT = 3
const COMPONENT_BUTTON = 2
const RESPONSE_UPDATE_MESSAGE = 7
const RESPONSE_CHANNEL_MESSAGE = 4
const FLAG_EPHEMERAL = 64

const buttonStyles = { primary: 1, secondary: 2, success: 3, danger: 4 } as const

const discordError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(effect, (cause) => new DiscordError({ operation, cause }))

const isThreadChannel = (channel: DiscordTypes.APIChannel): channel is DiscordTypes.APIThreadChannel =>
  channel.type === 10 || channel.type === 11 || channel.type === 12

const describeChannel = (channel: DiscordTypes.APIChannel): ChannelInfo => {
  const guildId = "guild_id" in channel ? Option.fromNullishOr(channel.guild_id).pipe(Option.map(GuildId.make)) : Option.none()

  return isThreadChannel(channel)
    ? { isThread: true, parentId: Option.fromNullishOr(channel.parent_id).pipe(Option.map(ChannelId.make)), guildId }
    : { isThread: false, parentId: Option.none(), guildId }
}

const displayName = (user: DiscordTypes.UserResponse) => user.global_name ?? user.username

const toInbound = (me: UserId, data: DiscordTypes.GatewayMessageCreateDispatchData): Inbound.Message => ({
  id: MessageId.make(data.id),
  channelId: ChannelId.make(data.channel_id),
  guildId: Option.fromNullishOr(data.guild_id).pipe(Option.map(GuildId.make)),
  authorId: UserId.make(data.author.id),
  authorName: data.member?.nick ?? displayName(data.author),
  authorIsBot: data.author.bot === true || data.author.id === me,
  memberRoles: data.member?.roles ?? [],
  content: data.content,
  mentionsMe: data.mentions.some((user) => user.id === me),
  repliesToMe: data.referenced_message?.author.id === me,
})

const isConversational = (data: DiscordTypes.GatewayMessageCreateDispatchData) =>
  (data.type === MESSAGE_TYPE_DEFAULT || data.type === MESSAGE_TYPE_REPLY) && data.content.trim() !== ""

const toButtonPress = (interaction: DiscordTypes.APIInteraction): Option.Option<ButtonPress> => {
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
      roles: interaction.member?.roles ?? [],
    },
  })
}

const truncate = (text: string, length: number) => (text.length <= length ? text : `${text.slice(0, length - 1)}…`)

const make = Effect.gen(function* () {
  const rest = yield* DiscordREST
  const gateway = yield* DiscordGateway

  const me = yield* rest.getMyUser().pipe(
    discordError("Discord.me"),
    Effect.map((user) => UserId.make(user.id)),
  )

  yield* Effect.logInfo("Connected to Discord", { user: me })

  const channelCache = yield* Cache.make({
    capacity: 1_000,
    timeToLive: Duration.hours(1),
    lookup: (channelId: ChannelId) =>
      rest.getChannel(channelId).pipe(Effect.map(describeChannel), discordError("Discord.channel")),
  })

  const guildCache = yield* Cache.make({
    capacity: 100,
    timeToLive: Duration.minutes(10),
    lookup: (guildId: GuildId) =>
      Effect.all([rest.getGuild(guildId), rest.listGuildRoles(guildId)]).pipe(
        Effect.map(([guild, roles]) => ({
          ownerId: guild.owner_id,
          administratorRoles: new Set(
            (roles ?? []).flatMap((role) => ((BigInt(role.permissions) & ADMINISTRATOR) === ADMINISTRATOR ? [role.id] : [])),
          ),
        })),
        discordError("Discord.guild"),
      ),
  })

  const messages = gateway
    .fromDispatch("MESSAGE_CREATE")
    .pipe(Stream.filter(isConversational), Stream.map((data) => toInbound(me, data)))

  const buttonPresses = gateway
    .fromDispatch("INTERACTION_CREATE")
    .pipe(Stream.map(toButtonPress), Stream.filter(Option.isSome), Stream.map((press) => press.value))

  const transcript = Effect.fn("Discord.transcript")(
    function* (channelId: ChannelId, before: Option.Option<MessageId>, limit: number) {
      const page = yield* rest.listMessages(channelId, { before: Option.getOrUndefined(before), limit })

      return (page ?? []).toReversed().map((message) => ({
        id: MessageId.make(message.id),
        authorName: displayName(message.author),
        isMe: message.author.id === me,
        content: message.content,
      }))
    },
    (effect) => discordError("Discord.transcript")(effect),
  )

  const send = Effect.fn("Discord.send")(
    function* (
      channelId: ChannelId,
      text: string,
      replyTo: Option.Option<MessageId>,
      buttons: ReadonlyArray<Button> = [],
    ) {
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

  const answerPress = Effect.fn("Discord.answerPress")(
    function* (press: ButtonPress, text: string) {
      yield* rest.createInteractionResponse(press.interactionId, press.token, {
        payload: {
          type: RESPONSE_UPDATE_MESSAGE,
          data: { content: truncate(text, MAX_MESSAGE_LENGTH), components: [], allowed_mentions: { parse: [] } },
        },
      })
    },
    (effect) => discordError("Discord.answerPress")(effect),
  )

  const answerPressPrivately = Effect.fn("Discord.answerPressPrivately")(
    function* (press: ButtonPress, text: string) {
      yield* rest.createInteractionResponse(press.interactionId, press.token, {
        payload: {
          type: RESPONSE_CHANNEL_MESSAGE,
          data: { content: truncate(text, MAX_MESSAGE_LENGTH), flags: FLAG_EPHEMERAL, allowed_mentions: { parse: [] } },
        },
      })
    },
    (effect) => discordError("Discord.answerPressPrivately")(effect),
  )

  return Service.of({
    me,
    messages,
    buttonPresses,
    channel: (channelId) => Cache.get(channelCache, channelId),
    guild: (guildId) => Cache.get(guildCache, guildId),
    transcript,
    send,
    edit,
    remove,
    react,
    unreact,
    typing,
    startThread,
    answerPress,
    answerPressPrivately,
  })
})

const intents = Intents.fromList(["Guilds", "GuildMessages", "MessageContent", "DirectMessages"])

const dfxLayer = DiscordLive.pipe(
  Layer.provide(
    DiscordConfig.layerConfig({ token: Config.Redacted("DISCORD_BOT_TOKEN"), gateway: Config.succeed({ intents }) }),
  ),
  Layer.provide(BunHttpClient.layer),
  Layer.provide(BunSocket.layerWebSocketConstructor),
)

export const layer = Layer.effect(Service, make).pipe(Layer.provide(dfxLayer))

export * as Discord from "./Discord.ts"
