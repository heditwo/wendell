import { BunHttpClient, BunSocket } from "@effect/platform-bun"
import { DiscordConfig, DiscordREST, Intents } from "dfx"
import { DiscordGateway, DiscordLive } from "dfx/gateway"
import { Cache, Config, Context, Duration, Effect, Layer, Option, Stream } from "effect"
import type { Inbound } from "../inbound/Inbound.ts"
import { type ChannelId, type GuildId, type MessageId, UserId } from "../shared/Ids.ts"
import { type DiscordError, discordError } from "./DiscordError.ts"
import type { Embeds } from "./Embeds.ts"
import { Identity } from "./Identity.ts"
import { Interactions } from "./Interactions.ts"
import { Messages } from "./Messages.ts"
import { Payloads } from "./Payloads.ts"
import type { Presence } from "./Presence.ts"

export { DiscordError } from "./DiscordError.ts"

export interface ChannelInfo {
  readonly isThread: boolean
  readonly parentId: Option.Option<ChannelId>
  readonly guildId: Option.Option<GuildId>
}

export interface TranscriptLine {
  readonly id: MessageId
  readonly authorId: UserId
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

/** Built field by field, so it stays mutable. */
export interface ProfileUpdate {
  username?: string
  avatar?: string | null
  banner?: string | null
}

export interface Interface {
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
  /** Global profile. Images are data URIs; `null` removes them. */
  readonly updateProfile: (update: ProfileUpdate) => Effect.Effect<void, DiscordError>
  /** The "About me" text, which is the application's description. */
  readonly updateAbout: (text: string | null) => Effect.Effect<void, DiscordError>
  readonly updateNickname: (guildId: GuildId, nickname: string | null) => Effect.Effect<void, DiscordError>
  /** False when no gateway connection is open. */
  readonly setPresence: (presence: Presence.Presence) => Effect.Effect<boolean>
  /** Emits after each gateway connection, when the presence must be set again. */
  readonly connected: Stream.Stream<void>
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

/** The only module that talks to Discord. The parts live in `Messages`, `Interactions` and `Identity`. */
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
      rest.getChannel(channelId).pipe(Effect.map(Payloads.describeChannel), discordError("Discord.channel")),
  })

  const interactions = gateway.fromDispatch("INTERACTION_CREATE")

  const commandsOf = (wanted: number) =>
    interactions.pipe(
      Stream.map((interaction) => Payloads.toCommandCall(interaction, wanted)),
      Stream.filter(Option.isSome),
      Stream.map((call) => call.value),
    )

  return Service.of({
    ...(yield* Messages.make(me)),
    ...(yield* Interactions.make),
    ...(yield* Identity.make),
    messages: gateway
      .fromDispatch("MESSAGE_CREATE")
      .pipe(Stream.filter(Payloads.isConversational), Stream.map((data) => Payloads.toInbound(me, data))),
    buttonPresses: interactions.pipe(
      Stream.map(Payloads.toButtonPress),
      Stream.filter(Option.isSome),
      Stream.map((press) => press.value),
    ),
    commands: commandsOf(Payloads.INTERACTION_APPLICATION_COMMAND),
    autocompletes: commandsOf(Payloads.INTERACTION_AUTOCOMPLETE),
    channel: (channelId) => Cache.get(channelCache, channelId),
    connected: gateway.fromDispatch("READY").pipe(Stream.map(() => undefined)),
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
