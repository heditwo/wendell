import { BunHttpClient, BunSocket } from "@effect/platform-bun"
import { DiscordConfig, DiscordREST, Discord as DiscordTypes, Intents } from "dfx"
import { DiscordGateway, DiscordLive } from "dfx/gateway"
import { Cache, Config, Context, Duration, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Embeds } from "./Embeds.ts"
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
  }
}

export interface CommandOption {
  readonly name: string
  readonly value: string
  readonly focused: boolean
}

/** A slash command, or an autocomplete request while someone types one. */
export interface CommandCall {
  readonly interactionId: string
  readonly token: string
  readonly applicationId: string
  readonly name: string
  readonly options: ReadonlyArray<CommandOption>
  readonly channelId: ChannelId
  readonly userName: string
  readonly member: {
    readonly userId: UserId
    readonly guildId: Option.Option<GuildId>
  }
}

export interface Choice {
  readonly name: string
  readonly value: string
}

export interface CommandSpec {
  readonly name: string
  readonly description: string
  readonly options: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly required: boolean
    readonly autocomplete: boolean
    readonly choices: ReadonlyArray<Choice>
  }>
}

export interface Upload {
  readonly name: string
  readonly data: Uint8Array<ArrayBuffer>
  readonly contentType: string
}

/** A message with optional files, embeds and one allowed user mention. */
export interface Outgoing {
  readonly text: string
  readonly replyTo: Option.Option<MessageId>
  readonly files: ReadonlyArray<Upload>
  readonly embeds: ReadonlyArray<Embeds.Embed>
  /** The only user that the message may ping. Everyone else, roles and @everyone never are. */
  readonly mention: Option.Option<UserId>
}

export class DiscordError extends Schema.TaggedError<DiscordError>()("Discord.DiscordError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly me: UserId
  readonly messages: Stream.Stream<Inbound.Message>
  readonly buttonPresses: Stream.Stream<ButtonPress>
  readonly commands: Stream.Stream<CommandCall>
  readonly autocompletes: Stream.Stream<CommandCall>
  /** Replaces Wendell's slash commands in every server he is in. Returns the number of servers. */
  readonly registerCommands: (commands: ReadonlyArray<CommandSpec>) => Effect.Effect<number, DiscordError>
  readonly answerAutocomplete: (call: CommandCall, choices: ReadonlyArray<Choice>) => Effect.Effect<void, DiscordError>
  /** Shows "Wendell is thinking…". Answer within 15 minutes with `editCommandAnswer`. */
  readonly deferCommand: (call: CommandCall, ephemeral: boolean) => Effect.Effect<void, DiscordError>
  readonly editCommandAnswer: (call: CommandCall, text: string) => Effect.Effect<void, DiscordError>
  readonly channel: (channelId: ChannelId) => Effect.Effect<ChannelInfo, DiscordError>
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
  readonly post: (channelId: ChannelId, message: Outgoing) => Effect.Effect<MessageId, DiscordError>
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
  /** A public thread without a starter message. Sub-tasks use it, because Discord has no threads inside threads. */
  readonly createThread: (channelId: ChannelId, name: string) => Effect.Effect<ChannelId, DiscordError>
  /** Replaces the pressed message's text and removes its buttons. */
  readonly answerPress: (press: ButtonPress, text: string) => Effect.Effect<void, DiscordError>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Discord") {}

const MESSAGE_TYPE_DEFAULT = 0
const MESSAGE_TYPE_REPLY = 19
const MAX_MESSAGE_LENGTH = 2000
const MAX_THREAD_NAME = 100
const ONE_WEEK_MINUTES = 10_080
const PUBLIC_THREAD = 11
const INTERACTION_APPLICATION_COMMAND = 2
const INTERACTION_MESSAGE_COMPONENT = 3
const INTERACTION_AUTOCOMPLETE = 4
const COMMAND_CHAT_INPUT = 1
const OPTION_STRING = 3
const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5
const RESPONSE_AUTOCOMPLETE = 8
const MAX_CHOICES = 25
const MAX_CHOICE_LENGTH = 100
const COMPONENT_BUTTON = 2
const RESPONSE_UPDATE_MESSAGE = 7
const FLAG_EPHEMERAL = 64

const API = "https://discord.com/api/v10"

const SentMessage = Schema.Struct({ id: Schema.String })

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
  content: data.content,
  attachments: data.attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.filename,
    url: attachment.url,
    contentType: Option.fromNullishOr(attachment.content_type),
    size: attachment.size,
  })),
  stickers: (data.sticker_items ?? []).map((sticker) => sticker.name),
  mentionsMe: data.mentions.some((user) => user.id === me),
  repliesToMe: data.referenced_message?.author.id === me,
})

const hasSubstance = (data: DiscordTypes.GatewayMessageCreateDispatchData) =>
  data.content.trim() !== "" || data.attachments.length > 0 || (data.sticker_items ?? []).length > 0

const isConversational = (data: DiscordTypes.GatewayMessageCreateDispatchData) =>
  (data.type === MESSAGE_TYPE_DEFAULT || data.type === MESSAGE_TYPE_REPLY) && hasSubstance(data)

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
    },
  })
}

const toCommandCall = (interaction: DiscordTypes.APIInteraction, wanted: number): Option.Option<CommandCall> => {
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

const truncate = (text: string, length: number) => (text.length <= length ? text : `${text.slice(0, length - 1)}…`)

const make = Effect.gen(function* () {
  const rest = yield* DiscordREST
  const http = yield* HttpClient.HttpClient
  const token = yield* Config.Redacted("DISCORD_BOT_TOKEN")
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


  const messages = gateway
    .fromDispatch("MESSAGE_CREATE")
    .pipe(Stream.filter(isConversational), Stream.map((data) => toInbound(me, data)))

  const buttonPresses = gateway
    .fromDispatch("INTERACTION_CREATE")
    .pipe(Stream.map(toButtonPress), Stream.filter(Option.isSome), Stream.map((press) => press.value))

  const interactions = gateway.fromDispatch("INTERACTION_CREATE")

  const commandsOf = (wanted: number) =>
    interactions.pipe(
      Stream.map((interaction) => toCommandCall(interaction, wanted)),
      Stream.filter(Option.isSome),
      Stream.map((call) => call.value),
    )

  const registerCommands = Effect.fn("Discord.registerCommands")(
    function* (commands: ReadonlyArray<CommandSpec>) {
      const application = yield* rest.getMyApplication()
      const guilds = yield* rest.listMyGuilds()

      const payload = commands.map((command): DiscordTypes.ApplicationCommandUpdateRequest => ({
        name: command.name,
        description: command.description,
        options: command.options.map((option) => ({
          type: OPTION_STRING,
          name: option.name,
          description: option.description,
          required: option.required,
          autocomplete: option.autocomplete,
          choices: option.choices.length === 0 ? undefined : option.choices,
        })),
      }))

      yield* Effect.forEach(guilds ?? [], (guild) => rest.bulkSetGuildApplicationCommands(application.id, guild.id, payload), {
        discard: true,
      })

      return (guilds ?? []).length
    },
    (effect) => discordError("Discord.registerCommands")(effect),
  )

  const answerAutocomplete = Effect.fn("Discord.answerAutocomplete")(
    function* (call: CommandCall, choices: ReadonlyArray<Choice>) {
      yield* rest.createInteractionResponse(call.interactionId, call.token, {
        payload: {
          type: RESPONSE_AUTOCOMPLETE,
          data: {
            choices: choices.slice(0, MAX_CHOICES).map((choice) => ({
              name: truncate(choice.name, MAX_CHOICE_LENGTH),
              value: choice.value.slice(0, MAX_CHOICE_LENGTH),
            })),
          },
        },
      })
    },
    (effect) => discordError("Discord.answerAutocomplete")(effect),
  )


  const deferCommand = Effect.fn("Discord.deferCommand")(
    function* (call: CommandCall, ephemeral: boolean) {
      yield* rest.createInteractionResponse(call.interactionId, call.token, {
        payload: { type: RESPONSE_DEFERRED_CHANNEL_MESSAGE, data: { flags: ephemeral ? FLAG_EPHEMERAL : undefined } },
      })
    },
    (effect) => discordError("Discord.deferCommand")(effect),
  )

  const editCommandAnswer = Effect.fn("Discord.editCommandAnswer")(
    function* (call: CommandCall, text: string) {
      yield* rest.updateOriginalWebhookMessage(call.applicationId, call.token, {
        payload: { content: truncate(text, MAX_MESSAGE_LENGTH), allowed_mentions: { parse: [] } },
      })
    },
    (effect) => discordError("Discord.editCommandAnswer")(effect),
  )

  const transcript = Effect.fn("Discord.transcript")(
    function* (channelId: ChannelId, before: Option.Option<MessageId>, limit: number) {
      const page = yield* rest.listMessages(channelId, { before: Option.getOrUndefined(before), limit })

      return (page ?? []).toReversed().map((message) => ({
        id: MessageId.make(message.id),
        authorName: displayName(message.author),
        isMe: message.author.id === me,
        content: [message.content, ...message.attachments.map((attachment) => `[attachment: ${attachment.filename}]`)]
          .filter((part) => part.trim() !== "")
          .join(" "),
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


  return Service.of({
    me,
    messages,
    buttonPresses,
    commands: commandsOf(INTERACTION_APPLICATION_COMMAND),
    autocompletes: commandsOf(INTERACTION_AUTOCOMPLETE),
    registerCommands,
    answerAutocomplete,
    deferCommand,
    editCommandAnswer,
    channel: (channelId) => Cache.get(channelCache, channelId),
    transcript,
    send,
    post,
    edit,
    remove,
    react,
    unreact,
    typing,
    startThread,
    createThread,
    answerPress,
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

export const layer = Layer.effect(Service, make).pipe(Layer.provide(dfxLayer), Layer.provide(BunHttpClient.layer))

export * as Discord from "./Discord.ts"
