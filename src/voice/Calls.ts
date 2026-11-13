import { Context, Data, Effect, Layer, type Option } from "effect"
import type { Conversation } from "../conversations/Conversation.ts"
import type { Discord } from "../discord/Discord.ts"
import type { ChannelId, GuildId, ServerName } from "../shared/Ids.ts"
import type { Voice } from "./Voice.ts"

/** A voice call that Wendell is connected to. */
export interface Call {
  readonly guildId: GuildId
  /** The voice channel. Its text chat has the same ID. */
  readonly channelId: ChannelId
  /** The conversation that asked Wendell to join. Speech in the call goes to it. */
  readonly home: Conversation
}

export type Hearing = Data.TaggedEnum<{
  /** Nothing was transcribed yet, and the check after the join has not finished. */
  Unchecked: {}
  Working: {}
  /** Speech recognition fails, so Wendell does not get what people say. */
  Failing: {}
  /** Transcription is off in `wendell.json`. */
  Off: {}
}>

export const Hearing = Data.taggedEnum<Hearing>()

/** One thing that a person said in the call, or typed while in it. */
export interface Line {
  readonly speaker: string
  readonly text: string
  readonly typed: boolean
}

/** Same contract as `Recollection.Recall`: run `delivered` only after the prompt was delivered. */
export interface Notice {
  readonly blocks: ReadonlyArray<string>
  readonly delivered: Effect.Effect<void>
}

export interface Interface {
  readonly enabled: boolean
  /** Joins the voice channel, or moves to it, waits until audio can play, and makes `home` the call's conversation. */
  readonly join: (guildId: GuildId, channelId: ChannelId, home: Conversation) => Effect.Effect<Call, Voice.VoiceError>
  /** False when Wendell was not in a voice channel of this guild. */
  readonly leave: (guildId: GuildId) => Effect.Effect<boolean>
  readonly all: Effect.Effect<ReadonlyArray<Call>>
  readonly inGuild: (guildId: GuildId) => Effect.Effect<Option.Option<Call>>
  /** The call in the voice channel with this ID. */
  readonly ofChannel: (channelId: ChannelId) => Effect.Effect<Option.Option<Call>>
  /** The call that belongs to this conversation. */
  readonly ofHome: (server: ServerName, channelId: ChannelId) => Effect.Effect<Option.Option<Call>>
  /** The people in the call's voice channel, without bots. */
  readonly people: (call: Call) => Effect.Effect<ReadonlyArray<Discord.VoiceMember>>
  /**
   * Speaks the readable part of `text` in the call. `from` is the conversation that said it, when it is not the
   * call's home. False when nothing is readable or the connection is gone.
   */
  readonly say: (call: Call, text: string, from: Option.Option<ChannelId>) => Effect.Effect<boolean>
  /**
   * Records a line of the call. `forWendell` false: the agent did not get it, so it stays for `takeOverheard`.
   * True: the agent gets it now, and Wendell is attentive.
   */
  readonly heard: (call: Call, line: Line, forWendell: boolean) => Effect.Effect<void>
  /** The last lines of the call, by people and by Wendell, as "name: text", for the decision model. */
  readonly lines: (call: Call) => Effect.Effect<ReadonlyArray<string>>
  /** The lines since the last call that the agent did not get, as a `<call_context>` block. Empty when there are none. */
  readonly takeOverheard: (call: Call) => Effect.Effect<ReadonlyArray<string>>
  /** Wendell spoke in the call, or got a line that was for him, a short time ago. */
  readonly attentive: (call: Call) => Effect.Effect<boolean>
  readonly hearing: (call: Call) => Effect.Effect<Hearing>
  /** Records the result of one transcription. Returns the change that people must be told about. */
  readonly transcribed: (call: Call, ok: boolean) => Effect.Effect<Option.Option<"lost" | "recovered">>
  /** Transcribes a short silent sound to learn if speech recognition works, and records the result. */
  readonly checkHearing: (call: Call) => Effect.Effect<Hearing>
  /** True one time after a person spoke over Wendell and his speech stopped. */
  readonly takeInterrupted: (call: Call) => Effect.Effect<boolean>
  /** What a conversation must know about Wendell's calls, as `<call>` blocks in front of its next batch. */
  readonly notice: (conversation: Conversation) => Effect.Effect<Notice>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Calls") {}

export const layer: Layer.Layer<Service> = Layer.effect(Service, Effect.die("Calls.layer is not implemented yet"))

export * as Calls from "./Calls.ts"
