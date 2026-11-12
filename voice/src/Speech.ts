import { Readable } from "node:stream";

import opus from "@discordjs/opus";

import { monoFromS16, Resampler, stereoS16FromMono } from "./Pcm.ts";
import { errorText, type TtsSettings } from "./Protocol.ts";

export const PLAYBACK_RATE = 48_000;

const DEFAULT_TTS_RATE = 24_000;

const FRAME_BYTES = (PLAYBACK_RATE / 50) * 2 * 2;

/** Turns 16-bit mono PCM chunks at any rate into 20 ms Opus packets at 48 kHz stereo. */
export class OpusPacketizer {
  readonly #encoder = new opus.OpusEncoder(PLAYBACK_RATE, 2);
  readonly #resampler: Resampler;
  #odd: Buffer = Buffer.alloc(0);
  #frame: Buffer = Buffer.alloc(0);

  constructor(inputRate: number) {
    this.#resampler = new Resampler(inputRate, PLAYBACK_RATE);
  }

  push(chunk: Buffer): Buffer[] {
    const bytes = this.#odd.length > 0 ? Buffer.concat([this.#odd, chunk]) : chunk;
    const even = bytes.length - (bytes.length % 2);

    this.#odd = bytes.subarray(even);

    return this.#encode(this.#resampler.process(monoFromS16(bytes.subarray(0, even))), false);
  }

  flush(): Buffer[] {
    return this.#encode(this.#resampler.flush(), true);
  }

  #encode(samples: Float32Array, last: boolean): Buffer[] {
    let pending = Buffer.concat([this.#frame, stereoS16FromMono(samples)]);
    const packets: Buffer[] = [];

    while (pending.length >= FRAME_BYTES) {
      packets.push(this.#encoder.encode(pending.subarray(0, FRAME_BYTES)));
      pending = pending.subarray(FRAME_BYTES);
    }

    if (last && pending.length > 0) {
      packets.push(this.#encoder.encode(Buffer.concat([pending, Buffer.alloc(FRAME_BYTES - pending.length)])));
      pending = Buffer.alloc(0);
    }

    this.#frame = Buffer.from(pending);

    return packets;
  }
}

export interface SpeechAudio {
  /** Object-mode stream of Opus packets, for `StreamType.Opus`. */
  readonly packets: Readable;
  /** Resolves when the speech server has sent everything, failed or was cancelled. Never rejects. */
  readonly done: Promise<void>;
  readonly error: () => string | undefined;
}

function sampleRateOf(response: Response): number {
  const header = Number(response.headers.get("x-sample-rate"));

  return Number.isInteger(header) && header > 0 ? header : DEFAULT_TTS_RATE;
}

async function stream(
  text: string,
  tts: TtsSettings,
  signal: AbortSignal,
  packets: Readable,
): Promise<void> {
  const response = await fetch(`${tts.url}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: text, voice: tts.voice, response_format: "pcm", stream: true }),
    signal,
  });

  if (!response.ok || response.body === null) {
    await response.body?.cancel();

    throw new Error(`speech server answered ${response.status}`);
  }

  const packetizer = new OpusPacketizer(sampleRateOf(response));

  for await (const chunk of response.body) {
    if (packets.destroyed) return;

    for (const packet of packetizer.push(Buffer.from(chunk))) packets.push(packet);
  }

  for (const packet of packetizer.flush()) packets.push(packet);

  packets.push(null);
}

export function synthesize(text: string, tts: TtsSettings, signal: AbortSignal): SpeechAudio {
  let failure: string | undefined;

  const packets = new Readable({ objectMode: true, highWaterMark: 1 << 20, read() {} });

  packets.on("error", () => {});

  const done = stream(text, tts, signal, packets).then(
    () => {},
    (cause: unknown) => {
      if (signal.aborted) return;

      failure = errorText(cause);
      packets.destroy(new Error(failure));
    },
  );

  signal.addEventListener("abort", () => packets.destroy(), { once: true });

  return { packets, done, error: () => failure };
}
