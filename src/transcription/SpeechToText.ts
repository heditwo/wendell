import { Context, Effect, Layer, Option } from "effect"
import { WendellConfig } from "../config/WendellConfig.ts"
import { CommandProvider } from "./CommandProvider.ts"
import { OpenAIProvider } from "./OpenAIProvider.ts"
import type { Provider } from "./Provider.ts"
import type { TranscriptionConfig } from "./TranscriptionConfig.ts"

/** The configured provider, or none when transcription is off. */
export class Service extends Context.Service<Service, Option.Option<Provider.Provider>>()("wendell/SpeechToText") {}

const provider = (config: TranscriptionConfig.Config) => {
  switch (config.provider) {
    case "off":
      return Effect.succeed(Option.none<Provider.Provider>())
    case "command":
      return CommandProvider.make(config).pipe(Effect.map(Option.some))
    case "openai":
      return OpenAIProvider.make(config).pipe(Effect.map(Option.some))
  }
}

/** Chooses the provider from `transcription.provider` in `wendell.json`. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* WendellConfig.Service

    return yield* provider(config.transcription)
  }),
)

export * as SpeechToText from "./SpeechToText.ts"
