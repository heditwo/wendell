import { Option, Schema } from "effect"
import { ChannelId, GuildId, UserId } from "../shared/Ids.ts"
import type { VoiceConfig } from "./VoiceConfig.ts"

/** The messages of `voice/PROTOCOL.md`: one JSON object per line on the sidecar's stdin and stdout. */

export type Outgoing =
  | { readonly type: "configure"; readonly tts: VoiceConfig.Resolved["tts"]; readonly vad: VoiceConfig.Resolved["vad"] }
  | { readonly type: "join"; readonly guildId: GuildId; readonly channelId: ChannelId; readonly userId: UserId }
  | { readonly type: "leave"; readonly guildId: GuildId }
  | { readonly type: "voiceStateUpdate"; readonly guildId: GuildId; readonly data: unknown }
  | { readonly type: "voiceServerUpdate"; readonly guildId: GuildId; readonly data: unknown }
  | { readonly type: "speak"; readonly guildId: GuildId; readonly id: string; readonly text: string }
  | { readonly type: "stop"; readonly guildId: GuildId }

export const encode = (message: Outgoing) => `${JSON.stringify(message)}\n`

/** The only gateway payload that the sidecar may send: a voice state update for its own guild. */
export const VoiceStatePayload = Schema.Struct({
  op: Schema.Literal(4),
  d: Schema.Struct({
    guild_id: GuildId,
    channel_id: Schema.NullOr(ChannelId),
    self_mute: Schema.Boolean,
    self_deaf: Schema.Boolean,
  }),
})

export interface VoiceStatePayload extends Schema.Schema.Type<typeof VoiceStatePayload> {}

export const Gateway = Schema.Struct({ type: Schema.tag("gateway"), guildId: GuildId, payload: Schema.Unknown })

export const Ready = Schema.Struct({ type: Schema.tag("ready"), guildId: GuildId, channelId: ChannelId })

export const Disconnected = Schema.Struct({ type: Schema.tag("disconnected"), guildId: GuildId, reason: Schema.String })

export const Utterance = Schema.Struct({
  type: Schema.tag("utterance"),
  guildId: GuildId,
  userId: UserId,
  wav: Schema.String,
  durationMs: Schema.Number,
})

export const Speech = Schema.Struct({
  type: Schema.tag("speech"),
  guildId: GuildId,
  id: Schema.String,
  state: Schema.Literals(["started", "finished", "interrupted", "failed"]),
  error: Schema.optional(Schema.String),
})

export const Log = Schema.Struct({
  type: Schema.tag("log"),
  level: Schema.Literals(["debug", "info", "warning", "error"]),
  message: Schema.String,
  fields: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const Incoming = Schema.Union([Gateway, Ready, Disconnected, Utterance, Speech, Log]).pipe(Schema.toTaggedUnion("type"))

export type Incoming = typeof Incoming.Type

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Incoming))

/** None for a line that is not one of the known messages. */
export const decode = (line: string): Option.Option<Incoming> => (line.trim() === "" ? Option.none() : decodeLine(line))

export const decodeVoiceState = Schema.decodeUnknownOption(VoiceStatePayload)

export * as Protocol from "./Protocol.ts"
