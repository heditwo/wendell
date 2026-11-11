import { type Effect, type Option, Schema } from "effect"

/** One audio file, as it came from Discord. */
export interface Audio {
  readonly name: string
  readonly contentType: Option.Option<string>
  readonly data: Uint8Array<ArrayBuffer>
}

export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()("Provider.TranscriptionError", {
  step: Schema.String,
  cause: Schema.Defect(),
}) {}

/** One result line of `bun run doctor`. */
export interface Check {
  readonly label: string
  readonly ok: boolean
  readonly detail: string
}

/** A way to turn speech into text. Add a provider by implementing this and adding a case to `SpeechToText.layer`. */
export interface Provider {
  /** For logs and the doctor, for example "command: voxtype". */
  readonly name: string
  readonly transcribe: (audio: Audio) => Effect.Effect<string, TranscriptionError>
  /** Checks that the provider can work on this machine. */
  readonly check: Effect.Effect<ReadonlyArray<Check>>
}

export * as Provider from "./Provider.ts"
