import type { DiscordGatewayAdapterLibraryMethods } from "@discordjs/voice";

export type Json = string | number | boolean | null | readonly Json[] | JsonFields;

export interface JsonFields {
  readonly [key: string]: Json;
}

export type VoiceStateData = Parameters<DiscordGatewayAdapterLibraryMethods["onVoiceStateUpdate"]>[0];

export type VoiceServerData = Parameters<DiscordGatewayAdapterLibraryMethods["onVoiceServerUpdate"]>[0];

export interface TtsSettings {
  readonly url: string;
  readonly voice: string;
}

export interface VadSettings {
  readonly silenceMs: number;
  readonly minSpeechMs: number;
  readonly maxUtteranceMs: number;
}

export interface Settings {
  readonly tts: TtsSettings;
  readonly vad: VadSettings;
}

export type Inbound =
  | { readonly type: "configure"; readonly settings: Settings }
  | { readonly type: "join"; readonly guildId: string; readonly channelId: string; readonly userId: string }
  | { readonly type: "leave"; readonly guildId: string }
  | { readonly type: "voiceStateUpdate"; readonly guildId: string; readonly data: VoiceStateData }
  | { readonly type: "voiceServerUpdate"; readonly guildId: string; readonly data: VoiceServerData }
  | { readonly type: "speak"; readonly guildId: string; readonly id: string; readonly text: string }
  | { readonly type: "stop"; readonly guildId: string };

export type ParseResult =
  | { readonly ok: true; readonly message: Inbound }
  | { readonly ok: false; readonly reason: string; readonly messageType?: string };

export type SpeechState = "started" | "finished" | "interrupted" | "failed";

export type LogLevel = "debug" | "info" | "warning" | "error";

export type Outbound =
  | { readonly type: "gateway"; readonly guildId: string; readonly payload: Json }
  | { readonly type: "ready"; readonly guildId: string; readonly channelId: string }
  | { readonly type: "disconnected"; readonly guildId: string; readonly reason: string }
  | {
      readonly type: "utterance";
      readonly guildId: string;
      readonly userId: string;
      readonly wav: string;
      readonly durationMs: number;
    }
  | {
      readonly type: "speech";
      readonly guildId: string;
      readonly id: string;
      readonly state: SpeechState;
      readonly error?: string;
    }
  | { readonly type: "log"; readonly level: LogLevel; readonly message: string; readonly fields?: JsonFields };

export type Send = (message: Outbound) => void;

export type Log = (level: LogLevel, message: string, fields?: JsonFields) => void;

class InvalidMessage extends Error {}

function isFields(value: Json | undefined): value is JsonFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: Json | undefined): value is string {
  return typeof value === "string";
}

function isNumber(value: Json | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFlag(value: Json | undefined): value is boolean {
  return typeof value === "boolean";
}

function fieldsOf(fields: JsonFields, key: string): JsonFields {
  const value = fields[key];

  if (!isFields(value)) throw new InvalidMessage(`"${key}" must be an object`);

  return value;
}

function textOf(fields: JsonFields, key: string): string {
  const value = fields[key];

  if (!isText(value) || value.length === 0) throw new InvalidMessage(`"${key}" must be a non-empty string`);

  return value;
}

function nullableTextOf(fields: JsonFields, key: string): string | null {
  const value = fields[key];

  if (value === null || value === undefined) return null;

  if (!isText(value)) throw new InvalidMessage(`"${key}" must be a string or null`);

  return value;
}

function flagOf(fields: JsonFields, key: string): boolean {
  const value = fields[key];

  return isFlag(value) ? value : false;
}

function durationOf(fields: JsonFields, key: string): number {
  const value = fields[key];

  if (!isNumber(value) || value <= 0) throw new InvalidMessage(`"${key}" must be a positive number`);

  return value;
}

function settingsOf(fields: JsonFields): Settings {
  const tts = fieldsOf(fields, "tts");
  const vad = fieldsOf(fields, "vad");
  const url = textOf(tts, "url");

  if (!URL.canParse(url)) throw new InvalidMessage(`"tts.url" must be a URL`);

  return {
    tts: { url: url.replace(/\/+$/u, ""), voice: textOf(tts, "voice") },
    vad: {
      silenceMs: durationOf(vad, "silenceMs"),
      minSpeechMs: durationOf(vad, "minSpeechMs"),
      maxUtteranceMs: durationOf(vad, "maxUtteranceMs"),
    },
  };
}

function voiceStateOf(fields: JsonFields, guildId: string): VoiceStateData {
  return {
    guild_id: nullableTextOf(fields, "guild_id") ?? guildId,
    channel_id: nullableTextOf(fields, "channel_id"),
    user_id: textOf(fields, "user_id"),
    session_id: textOf(fields, "session_id"),
    deaf: flagOf(fields, "deaf"),
    mute: flagOf(fields, "mute"),
    self_deaf: flagOf(fields, "self_deaf"),
    self_mute: flagOf(fields, "self_mute"),
    self_video: flagOf(fields, "self_video"),
    suppress: flagOf(fields, "suppress"),
    request_to_speak_timestamp: nullableTextOf(fields, "request_to_speak_timestamp"),
  };
}

function voiceServerOf(fields: JsonFields, guildId: string): VoiceServerData {
  return {
    token: textOf(fields, "token"),
    guild_id: nullableTextOf(fields, "guild_id") ?? guildId,
    endpoint: nullableTextOf(fields, "endpoint"),
  };
}

function inboundOf(fields: JsonFields, type: string): Inbound {
  switch (type) {
    case "configure":
      return { type, settings: settingsOf(fields) };
    case "join":
      return {
        type,
        guildId: textOf(fields, "guildId"),
        channelId: textOf(fields, "channelId"),
        userId: textOf(fields, "userId"),
      };
    case "leave":
    case "stop":
      return { type, guildId: textOf(fields, "guildId") };
    case "voiceStateUpdate": {
      const guildId = textOf(fields, "guildId");

      return { type, guildId, data: voiceStateOf(fieldsOf(fields, "data"), guildId) };
    }

    case "voiceServerUpdate": {
      const guildId = textOf(fields, "guildId");

      return { type, guildId, data: voiceServerOf(fieldsOf(fields, "data"), guildId) };
    }

    case "speak": {
      const text = fields["text"];

      if (!isText(text)) throw new InvalidMessage(`"text" must be a string`);

      return { type, guildId: textOf(fields, "guildId"), id: textOf(fields, "id"), text };
    }

    default:
      throw new InvalidMessage("unknown type");
  }
}

export function parseLine(line: string): ParseResult {
  let value: Json;

  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }

  if (!isFields(value)) return { ok: false, reason: "not a JSON object" };

  const type = value["type"];

  if (!isText(type)) return { ok: false, reason: `"type" must be a string` };

  try {
    return { ok: true, message: inboundOf(value, type) };
  } catch (error) {
    if (error instanceof InvalidMessage) return { ok: false, reason: error.message, messageType: type };

    throw error;
  }
}

export function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;

  return String(cause);
}
