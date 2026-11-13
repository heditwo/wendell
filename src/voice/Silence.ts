import { Duration, Effect, Option } from "effect"
import { Provider } from "../transcription/Provider.ts"

const SAMPLE_RATE = 16_000
const SECONDS = 1
const HEADER_BYTES = 44
const PROBE_TIMEOUT = Duration.seconds(20)

/** One second of silence: 16 kHz, mono, 16-bit WAV. */
export const wav = (): Uint8Array<ArrayBuffer> => {
  const dataBytes = SAMPLE_RATE * SECONDS * 2
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes)
  const view = new DataView(bytes.buffer)
  const tag = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))

  tag(0, "RIFF")
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true)
  tag(8, "WAVE")
  tag(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, "data")
  view.setUint32(40, dataBytes, true)

  return bytes
}

/** What the failure of a probe says, without any transcript. */
export const describe = (error: Provider.TranscriptionError) =>
  `${error.step}: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`

/**
 * Transcribes the silent sound. It succeeds when the provider runs and answers, even with no text, because silence
 * has no words. It fails when the provider fails or does not answer in time.
 */
export const probe = (provider: Provider.Provider) =>
  provider.transcribe({ name: "silence.wav", contentType: Option.some("audio/wav"), data: wav() }).pipe(
    Effect.timeoutOrElse({
      duration: PROBE_TIMEOUT,
      orElse: () => Effect.fail(new Provider.TranscriptionError({ step: provider.name, cause: "no answer in 20 seconds" })),
    }),
    Effect.asVoid,
  )

export * as Silence from "./Silence.ts"
