import { Schema } from "effect"

const Milliseconds = Schema.Int.check(Schema.isGreaterThan(0))

/** `voice` in `wendell.json`. Voice is on when this key is present. */
export const Config = Schema.Struct({
  /** The command that starts the voice sidecar, from the repository root. Default: `["node", "voice/sidecar.ts"]`. */
  sidecar: Schema.optional(Schema.NonEmptyArray(Schema.NonEmptyString)),
  tts: Schema.optional(
    Schema.Struct({
      /** Base URL of the speech server. Default: `http://127.0.0.1:8880`. */
      url: Schema.optional(Schema.NonEmptyString),
      /** Default: `verity`. */
      voice: Schema.optional(Schema.NonEmptyString),
    }),
  ),
  vad: Schema.optional(
    Schema.Struct({
      /** Silence that ends an utterance. Default: 700. */
      silenceMs: Schema.optional(Milliseconds),
      /** Shorter speech is dropped. Default: 400. */
      minSpeechMs: Schema.optional(Milliseconds),
      /** Longer speech is cut into several utterances. Default: 15000. */
      maxUtteranceMs: Schema.optional(Milliseconds),
    }),
  ),
})

export interface Config extends Schema.Schema.Type<typeof Config> {}

export interface Resolved {
  readonly sidecar: readonly [string, ...Array<string>]
  readonly tts: { readonly url: string; readonly voice: string }
  readonly vad: { readonly silenceMs: number; readonly minSpeechMs: number; readonly maxUtteranceMs: number }
}

export const resolve = (config: Config): Resolved => ({
  sidecar: config.sidecar ?? ["node", "voice/sidecar.ts"],
  tts: {
    url: (config.tts?.url ?? "http://127.0.0.1:8880").replace(/\/+$/, ""),
    voice: config.tts?.voice ?? "verity",
  },
  vad: {
    silenceMs: config.vad?.silenceMs ?? 700,
    minSpeechMs: config.vad?.minSpeechMs ?? 400,
    maxUtteranceMs: config.vad?.maxUtteranceMs ?? 15_000,
  },
})

export * as VoiceConfig from "./VoiceConfig.ts"
