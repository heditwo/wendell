import { Schema } from "effect"
import { CommandProvider } from "./CommandProvider.ts"
import { OpenAIProvider } from "./OpenAIProvider.ts"

export const Off = Schema.Struct({ provider: Schema.Literal("off") })

/** `transcription` in `wendell.json`: one provider's settings, chosen by `provider`. Each provider owns its schema. */
export const Config = Schema.Union([Off, CommandProvider.Config, OpenAIProvider.Config])

export type Config = typeof Config.Type

export const off: Config = { provider: "off" }

export * as TranscriptionConfig from "./TranscriptionConfig.ts"
