import {
  type AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  createAudioPlayer,
  createAudioResource,
  type DiscordGatewayAdapterLibraryMethods,
  EndBehaviorType,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  VoiceConnectionDisconnectReason,
  type VoiceConnectionState,
  VoiceConnectionStatus,
} from "@discordjs/voice";

import { Listener } from "./Listener.ts";
import {
  errorText,
  type Log,
  type Send,
  type Settings,
  type SpeechState,
  type VoiceServerData,
  type VoiceStateData,
} from "./Protocol.ts";
import { type SpeechAudio, synthesize } from "./Speech.ts";

const JOIN_TIMEOUT_MS = 30_000;

// A move to another channel or a voice server change briefly disconnects. Wait this long for the new connection before giving up.
const RECONNECT_GRACE_MS = 5_000;

const MAX_REJOIN_ATTEMPTS = 5;

// The player stops after this many 20 ms frames without audio. The speech server can be slower than real time for a moment.
const MAX_MISSED_FRAMES = 750;

const SUBSCRIPTION_IDLE_MS = 60_000;

interface SpeechItem {
  readonly id: string;
  readonly text: string;
  readonly controller: AbortController;
  audio?: SpeechAudio;
  resource?: AudioResource;
  error?: string;
  started: boolean;
}

/** One guild's voice connection, its speech queue and its listeners. */
export class GuildVoice {
  readonly guildId: string;
  readonly #settings: Settings;
  readonly #send: Send;
  readonly #log: Log;
  readonly #onClosed: () => void;
  readonly #player: AudioPlayer;
  readonly #listeners = new Map<string, Listener>();
  #connection: VoiceConnection | undefined;
  #adapter: DiscordGatewayAdapterLibraryMethods | undefined;
  #userId: string | undefined;
  #ready = false;
  #closed = false;
  #closeReason = "connection destroyed";
  #joinTimer: NodeJS.Timeout | undefined;
  #current: SpeechItem | undefined;
  #queue: SpeechItem[] = [];
  #downloading = false;

  constructor(guildId: string, settings: Settings, send: Send, log: Log, onClosed: () => void) {
    this.guildId = guildId;
    this.#settings = settings;
    this.#send = send;
    this.#log = log;
    this.#onClosed = onClosed;
    this.#player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: MAX_MISSED_FRAMES },
    });
    this.#player.on("error", (error) => {
      const item = this.#current;

      if (item !== undefined && error.resource === item.resource) item.error ??= error.message;

      this.#log("warning", "playback error", { guildId, error: error.message });
    });
    this.#player.on("stateChange", (previous, next) => this.#guard(() => this.#onPlayerState(previous, next)));
  }

  get closed(): boolean {
    return this.#closed;
  }

  join(channelId: string, userId: string): void {
    this.#userId = userId;
    this.#ready = false;
    this.#armJoinTimer();

    if (this.#connection !== undefined) {
      this.#connection.rejoin({ channelId, selfDeaf: false, selfMute: false });

      return;
    }

    const connection = joinVoiceChannel({
      guildId: this.guildId,
      channelId,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
      adapterCreator: (methods) => {
        this.#adapter = methods;

        return {
          sendPayload: (payload) => {
            this.#send({ type: "gateway", guildId: this.guildId, payload });

            return true;
          },
          destroy: () => {
            this.#adapter = undefined;
          },
        };
      },
    });

    this.#connection = connection;
    connection.on("stateChange", (previous, next) => this.#guard(() => this.#onConnectionState(previous, next)));
    connection.on("error", (error) => this.#log("warning", "voice connection error", { guildId: this.guildId, error: error.message }));
    connection.receiver.speaking.on("start", (speakerId) => this.#guard(() => this.#listen(speakerId)));
  }

  voiceState(data: VoiceStateData): void {
    if (this.#userId !== undefined && data.user_id !== this.#userId) return;

    this.#adapter?.onVoiceStateUpdate(data);
  }

  voiceServer(data: VoiceServerData): void {
    this.#adapter?.onVoiceServerUpdate(data);
  }

  leave(reason: string): void {
    this.#closeReason = reason;

    if (this.#connection === undefined || this.#connection.state.status === VoiceConnectionStatus.Destroyed) {
      this.#send({
        type: "gateway",
        guildId: this.guildId,
        payload: { op: 4, d: { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false } },
      });
      this.#close();

      return;
    }

    this.#connection.destroy();
  }

  speak(id: string, text: string): void {
    this.#queue.push({ id, text, controller: new AbortController(), started: false });
    this.#download();
    this.#playNext();
  }

  stop(): void {
    this.#interrupt();
  }

  #guard(action: () => void): void {
    try {
      action();
    } catch (cause) {
      this.#log("error", "voice handler failed", { guildId: this.guildId, error: errorText(cause) });
    }
  }

  #armJoinTimer(): void {
    clearTimeout(this.#joinTimer);
    this.#joinTimer = setTimeout(() => {
      if (this.#ready) return;

      this.#log("warning", "voice connection was not ready in time", { guildId: this.guildId });
      this.leave("timeout");
    }, JOIN_TIMEOUT_MS);
  }

  #onConnectionState(previous: VoiceConnectionState, next: VoiceConnectionState): void {
    if (previous.status === next.status) return;

    this.#log("debug", "voice connection state", { guildId: this.guildId, from: previous.status, to: next.status });

    switch (next.status) {
      case VoiceConnectionStatus.Ready: {
        clearTimeout(this.#joinTimer);
        this.#ready = true;
        this.#connection?.subscribe(this.#player);

        const channelId = this.#connection?.joinConfig.channelId;

        if (channelId !== undefined && channelId !== null) this.#send({ type: "ready", guildId: this.guildId, channelId });

        this.#playNext();

        return;
      }

      case VoiceConnectionStatus.Disconnected:
        this.#ready = false;
        void this.#recover(next.reason === VoiceConnectionDisconnectReason.WebSocketClose ? `closed with code ${next.closeCode}` : "disconnected");

        return;
      case VoiceConnectionStatus.Destroyed:
        this.#close();

        return;
      default:
        this.#ready = false;
    }
  }

  async #recover(reason: string): Promise<void> {
    const connection = this.#connection;

    if (connection === undefined) return;

    const reconnecting = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => settle(false), RECONNECT_GRACE_MS);

      const onState = (_previous: VoiceConnectionState, next: VoiceConnectionState) => {
        if (next.status !== VoiceConnectionStatus.Disconnected) settle(next.status !== VoiceConnectionStatus.Destroyed);
      };

      const settle = (result: boolean) => {
        clearTimeout(timer);
        connection.off("stateChange", onState);
        resolve(result);
      };

      connection.on("stateChange", onState);
    });

    if (!reconnecting) this.#destroy(reason);
    else if (connection.rejoinAttempts > MAX_REJOIN_ATTEMPTS) this.#destroy("too many reconnects");
  }

  #destroy(reason: string): void {
    this.#closeReason = reason;

    if (this.#connection?.state.status !== VoiceConnectionStatus.Destroyed) this.#connection?.destroy();
  }

  #close(): void {
    if (this.#closed) return;

    this.#closed = true;
    this.#ready = false;
    clearTimeout(this.#joinTimer);
    this.#interrupt();

    for (const listener of this.#listeners.values()) listener.close();

    this.#listeners.clear();
    this.#send({ type: "disconnected", guildId: this.guildId, reason: this.#closeReason });
    this.#onClosed();
  }

  #listen(speakerId: string): void {
    const connection = this.#connection;

    if (connection === undefined || this.#listeners.has(speakerId)) return;

    const listener = new Listener(
      this.#settings.vad,
      (utterance) => {
        this.#send({
          type: "utterance",
          guildId: this.guildId,
          userId: speakerId,
          wav: utterance.wav.toString("base64"),
          durationMs: utterance.durationMs,
        });
      },
      () => this.#bargeIn(speakerId),
      (cause) => this.#log("warning", "audio receive error", { guildId: this.guildId, userId: speakerId, error: errorText(cause) }),
    );

    const subscription = connection.receiver.subscribe(speakerId, {
      end: { behavior: EndBehaviorType.AfterInactivity, duration: SUBSCRIPTION_IDLE_MS },
    });

    const finish = () => {
      if (this.#listeners.get(speakerId) !== listener) return;

      this.#listeners.delete(speakerId);
      this.#guard(() => listener.close());
    };

    this.#listeners.set(speakerId, listener);
    subscription.on("data", (packet: Buffer) => this.#guard(() => listener.packet(packet, Date.now())));
    subscription.on("end", finish);
    subscription.on("close", finish);
    subscription.on("error", (error) => {
      this.#log("warning", "audio receive stream error", { guildId: this.guildId, userId: speakerId, error: error.message });
      finish();
    });
  }

  #bargeIn(speakerId: string): void {
    if (this.#current === undefined) return;

    this.#log("info", "a person spoke during speech, speech stopped", { guildId: this.guildId, userId: speakerId });
    this.#interrupt();
  }

  #report(item: SpeechItem, state: SpeechState, error?: string): void {
    this.#send(
      error === undefined
        ? { type: "speech", guildId: this.guildId, id: item.id, state }
        : { type: "speech", guildId: this.guildId, id: item.id, state, error },
    );
  }

  #interrupt(): void {
    const items = this.#current === undefined ? this.#queue : [this.#current, ...this.#queue];

    this.#current = undefined;
    this.#queue = [];

    for (const item of items) {
      item.controller.abort();
      this.#report(item, "interrupted");
    }

    this.#player.stop(true);
  }

  // The speech server makes one answer at a time, so the next item is requested only when the previous answer is complete.
  #download(): void {
    if (this.#downloading || this.#closed) return;

    const item = [this.#current, ...this.#queue].find((candidate) => candidate !== undefined && candidate.audio === undefined);

    if (item === undefined) return;

    const audio = synthesize(item.text, this.#settings.tts, item.controller.signal);

    item.audio = audio;
    this.#downloading = true;
    void audio.done.then(() => {
      this.#downloading = false;

      const error = audio.error();

      if (error !== undefined) {
        item.error ??= error;
        this.#log("warning", "speech server failed", { guildId: this.guildId, id: item.id, error });
      }

      this.#guard(() => {
        this.#download();
        this.#playNext();
      });
    });
  }

  #playNext(): void {
    while (this.#current === undefined && this.#ready && !this.#closed) {
      const item = this.#queue.shift();

      if (item === undefined) return;

      this.#download();

      const audio = item.audio;

      if (audio === undefined) {
        this.#queue.unshift(item);

        return;
      }

      if (audio.packets.destroyed) {
        this.#report(item, "failed", item.error ?? audio.error() ?? "speech audio is not available");

        continue;
      }

      try {
        const resource = createAudioResource(audio.packets, { inputType: StreamType.Opus });

        item.resource = resource;
        this.#current = item;
        this.#player.play(resource);
      } catch (cause) {
        this.#current = undefined;
        this.#report(item, "failed", errorText(cause));
      }
    }
  }

  #onPlayerState(previous: { status: AudioPlayerStatus; resource?: AudioResource }, next: { status: AudioPlayerStatus; resource?: AudioResource }): void {
    const item = this.#current;

    if (item === undefined) return;

    if (next.status === AudioPlayerStatus.Playing && next.resource === item.resource && !item.started) {
      item.started = true;
      this.#report(item, "started");

      return;
    }

    if (next.status !== AudioPlayerStatus.Idle || previous.status === AudioPlayerStatus.Idle || previous.resource !== item.resource) return;

    this.#current = undefined;

    const error = item.error ?? item.audio?.error();

    if (error !== undefined) this.#report(item, "failed", error);
    else if (item.audio?.packets.readableEnded === true) this.#report(item, "finished");
    else this.#report(item, "failed", "playback ended before the speech audio was complete");

    this.#playNext();
  }
}
