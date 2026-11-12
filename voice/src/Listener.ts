import opus from "@discordjs/opus";

import { monoFromStereoS16, resample, s16FromMono, wavFromS16 } from "./Pcm.ts";
import type { VadSettings } from "./Protocol.ts";
import { SEGMENT_RATE, Segmenter } from "./Segmenter.ts";

export const UTTERANCE_RATE = 16_000;

export interface Utterance {
  readonly wav: Buffer;
  readonly durationMs: number;
}

export function utteranceOf(samples: Float32Array): Utterance {
  const pcm = s16FromMono(resample(samples, SEGMENT_RATE, UTTERANCE_RATE));

  return {
    wav: wavFromS16(pcm, UTTERANCE_RATE, 1),
    durationMs: Math.round((pcm.length / 2 / UTTERANCE_RATE) * 1000),
  };
}

/** Decodes one person's Opus packets and cuts them into utterances. */
export class Listener {
  readonly #decoder = new opus.OpusEncoder(SEGMENT_RATE, 2);
  readonly #segmenter: Segmenter;
  readonly #silenceMs: number;
  readonly #onError: (cause: unknown) => void;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    vad: VadSettings,
    onUtterance: (utterance: Utterance) => void,
    onSpeech: () => void,
    onError: (cause: unknown) => void,
  ) {
    this.#silenceMs = vad.silenceMs;
    this.#onError = onError;
    this.#segmenter = new Segmenter(
      vad,
      (samples) => {
        try {
          onUtterance(utteranceOf(samples));
        } catch (cause) {
          onError(cause);
        }
      },
      onSpeech,
    );
  }

  packet(packet: Buffer, now: number): void {
    let frame: Float32Array;

    try {
      frame = monoFromStereoS16(this.#decoder.decode(packet));
    } catch (cause) {
      this.#onError(cause);

      return;
    }

    this.#segmenter.push(frame, now);
    this.#schedule();
  }

  close(): void {
    clearTimeout(this.#timer);
    this.#segmenter.flush();
  }

  #schedule(): void {
    clearTimeout(this.#timer);

    if (!this.#segmenter.active) return;

    this.#timer = setTimeout(() => this.#segmenter.expire(Date.now()), this.#silenceMs + 10);
  }
}
