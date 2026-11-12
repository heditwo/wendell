import { joinSamples, rms } from "./Pcm.ts";
import type { VadSettings } from "./Protocol.ts";

export const SEGMENT_RATE = 48_000;

// About -45 dBFS. Discord clients send only what their own voice detection lets through, so this mainly separates the pauses between words from speech.
const VOICE_LEVEL = 0.0056;

// Packets arrive with network jitter. Only a longer gap means that the client stopped sending, so only that becomes silence.
const PAUSE_GAP_MS = 100;

const LEAD_MS = 100;
const TAIL_MS = 250;

function samplesFor(ms: number): number {
  return Math.round((ms * SEGMENT_RATE) / 1000);
}

function msFor(samples: number): number {
  return (samples * 1000) / SEGMENT_RATE;
}

/** Cuts one person's 48 kHz mono audio into utterances. Times are in milliseconds and come from the caller. */
export class Segmenter {
  readonly #vad: VadSettings;
  readonly #onUtterance: (samples: Float32Array) => void;
  readonly #onSpeech: () => void;
  #lead: Float32Array[] = [];
  #leadSamples = 0;
  #chunks: Float32Array[] = [];
  #samples = 0;
  #voicedMs = 0;
  #voicedEndSamples = 0;
  #voicedEndAt = 0;
  #lastFrameEndAt = 0;
  #active = false;
  #announced = false;

  constructor(vad: VadSettings, onUtterance: (samples: Float32Array) => void, onSpeech: () => void) {
    this.#vad = vad;
    this.#onUtterance = onUtterance;
    this.#onSpeech = onSpeech;
  }

  get active(): boolean {
    return this.#active;
  }

  push(frame: Float32Array, now: number): void {
    this.expire(now);

    const frameMs = msFor(frame.length);
    const voiced = rms(frame) >= VOICE_LEVEL;

    if (!this.#active) {
      if (voiced) this.#start();
      else {
        this.#keepLead(frame);
        this.#lastFrameEndAt = now + frameMs;

        return;
      }
    } else {
      const gapMs = now - this.#lastFrameEndAt;

      if (gapMs > PAUSE_GAP_MS) this.#append(new Float32Array(samplesFor(Math.min(gapMs, this.#vad.silenceMs))));
    }

    this.#append(frame);
    this.#lastFrameEndAt = now + frameMs;

    if (voiced) {
      this.#voicedMs += frameMs;
      this.#voicedEndSamples = this.#samples;
      this.#voicedEndAt = now + frameMs;

      if (!this.#announced && this.#voicedMs >= this.#vad.minSpeechMs) {
        this.#announced = true;
        this.#onSpeech();
      }
    }

    if (msFor(this.#samples) >= this.#vad.maxUtteranceMs) this.#finish(this.#samples);
  }

  expire(now: number): void {
    if (this.#active && now - this.#voicedEndAt >= this.#vad.silenceMs) {
      this.#finish(Math.min(this.#samples, this.#voicedEndSamples + samplesFor(TAIL_MS)));
    }
  }

  flush(): void {
    if (this.#active) this.#finish(Math.min(this.#samples, this.#voicedEndSamples + samplesFor(TAIL_MS)));
  }

  #start(): void {
    this.#chunks = this.#lead;
    this.#samples = this.#leadSamples;
    this.#lead = [];
    this.#leadSamples = 0;
    this.#voicedMs = 0;
    this.#voicedEndSamples = this.#samples;
    this.#active = true;
    this.#announced = false;
  }

  #keepLead(frame: Float32Array): void {
    this.#lead.push(frame);
    this.#leadSamples += frame.length;

    while (this.#lead.length > 1 && this.#leadSamples - (this.#lead[0]?.length ?? 0) >= samplesFor(LEAD_MS)) {
      this.#leadSamples -= this.#lead.shift()?.length ?? 0;
    }
  }

  #append(samples: Float32Array): void {
    this.#chunks.push(samples);
    this.#samples += samples.length;
  }

  #finish(length: number): void {
    const chunks = this.#chunks;
    const keep = this.#voicedMs >= this.#vad.minSpeechMs;

    this.#chunks = [];
    this.#samples = 0;
    this.#active = false;
    this.#voicedMs = 0;

    if (keep) this.#onUtterance(joinSamples(chunks, length));
  }
}
