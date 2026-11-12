import { createInterface } from "node:readline";

import { GuildVoice } from "./src/GuildVoice.ts";
import { errorText, type Inbound, type JsonFields, type Log, type LogLevel, type Outbound, parseLine, type Settings } from "./src/Protocol.ts";

const SHUTDOWN_LIMIT_MS = 3_000;

const guilds = new Map<string, GuildVoice>();

let settings: Settings | undefined;

let stopping = false;

function send(message: Outbound): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const log: Log = (level: LogLevel, message: string, fields?: JsonFields) => {
  send(fields === undefined ? { type: "log", level, message } : { type: "log", level, message, fields });
};

function guildFor(guildId: string, configured: Settings): GuildVoice {
  const existing = guilds.get(guildId);

  if (existing !== undefined && !existing.closed) return existing;

  const created = new GuildVoice(guildId, configured, send, log, () => {
    if (guilds.get(guildId) === created) guilds.delete(guildId);
  });

  guilds.set(guildId, created);

  return created;
}

function handle(message: Inbound): void {
  if (message.type === "configure") {
    if (settings !== undefined) log("warning", "configure was sent again, new settings apply to new connections");

    settings = message.settings;

    return;
  }

  if (settings === undefined) {
    log("warning", "message before configure was ignored", { type: message.type });

    if (message.type === "speak") {
      send({ type: "speech", guildId: message.guildId, id: message.id, state: "failed", error: "not configured" });
    }

    return;
  }

  const existing = guilds.get(message.guildId);

  switch (message.type) {
    case "join":
      guildFor(message.guildId, settings).join(message.channelId, message.userId);

      return;
    case "leave":
      guildFor(message.guildId, settings).leave("left");

      return;
    case "voiceStateUpdate":
      existing?.voiceState(message.data);

      return;
    case "voiceServerUpdate":
      existing?.voiceServer(message.data);

      return;
    case "speak":
      if (existing === undefined) {
        send({ type: "speech", guildId: message.guildId, id: message.id, state: "failed", error: "not in a voice channel" });

        return;
      }

      existing.speak(message.id, message.text);

      return;
    case "stop":
      existing?.stop();
  }
}

function onLine(line: string): void {
  if (line.trim().length === 0) return;

  const result = parseLine(line);

  if (!result.ok) {
    log("warning", "ignored a message", result.messageType === undefined ? { reason: result.reason } : { reason: result.reason, type: result.messageType });

    return;
  }

  try {
    handle(result.message);
  } catch (cause) {
    log("error", "message handler failed", { type: result.message.type, error: errorText(cause) });
  }
}

function shutdown(): void {
  if (stopping) return;

  stopping = true;

  for (const guild of guilds.values()) {
    try {
      guild.leave("shutdown");
    } catch (cause) {
      log("error", "leave failed during shutdown", { guildId: guild.guildId, error: errorText(cause) });
    }
  }

  setTimeout(() => process.exit(0), SHUTDOWN_LIMIT_MS).unref();
  process.stdout.write("", () => process.exit(0));
}

process.on("uncaughtException", (error) => log("error", "uncaught exception", { error: error.message }));

process.on("unhandledRejection", (cause) => log("error", "unhandled rejection", { error: errorText(cause) }));

process.on("SIGTERM", shutdown);

process.on("SIGINT", shutdown);

process.stdout.on("error", () => process.exit(0));

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", onLine).on("close", shutdown);

log("info", "voice sidecar started", { node: process.version });
