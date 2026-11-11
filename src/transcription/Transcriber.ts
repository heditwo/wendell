import { Context, Duration, Effect, HashMap, Layer, Option, Ref } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import path from "node:path"
import { Attachments } from "../inbound/Attachments.ts"
import type { Inbound } from "../inbound/Inbound.ts"
import { Provider } from "./Provider.ts"
import { SpeechToText } from "./SpeechToText.ts"

const TIMEOUT = Duration.minutes(3)
const AUDIO_EXTENSIONS = new Set([".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".webm", ".flac", ".aac"])

export interface Interface {
  /**
   * The text of the message's voice messages and audio files, from the configured speech-to-text provider.
   * None when there is no audio or transcription is off. Never fails; results are cached per attachment.
   */
  readonly transcribe: (message: Inbound.Message) => Effect.Effect<Option.Option<string>>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Transcriber") {}

export const isAudio = (attachment: Inbound.Attachment) =>
  Option.exists(attachment.contentType, (type) => type.toLowerCase().startsWith("audio/")) ||
  AUDIO_EXTENSIONS.has(path.extname(attachment.name).toLowerCase())

const words = (text: string) => (text === "" ? 0 : text.split(/\s+/).length)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* SpeechToText.Service
    const http = yield* HttpClient.HttpClient
    const cache = yield* Ref.make(HashMap.empty<string, Option.Option<string>>())

    const download = Effect.fn("Transcriber.download")(function* (attachment: Inbound.Attachment) {
      const response = yield* http.execute(HttpClientRequest.get(attachment.url)).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))

      return new Uint8Array(yield* response.arrayBuffer)
    })

    const transcribeOne = (active: Provider.Provider, attachment: Inbound.Attachment) =>
      Effect.gen(function* () {
        const cached = HashMap.get(yield* Ref.get(cache), attachment.id)

        if (Option.isSome(cached)) return cached.value

        const text = yield* download(attachment).pipe(
          Effect.mapError((cause) => new Provider.TranscriptionError({ step: "download", cause })),
          Effect.flatMap((data) => active.transcribe({ name: attachment.name, contentType: attachment.contentType, data })),
          Effect.map((result) => Option.some(result).pipe(Option.filter((value) => value !== ""))),
          Effect.timeout(TIMEOUT),
          Effect.tap((result) =>
            Effect.logInfo("Transcribed a voice message", {
              attachment: attachment.id,
              provider: active.name,
              words: words(Option.getOrElse(result, () => "")),
            }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Could not transcribe a voice message", { attachment: attachment.id, provider: active.name, cause }).pipe(
              Effect.as(Option.none<string>()),
            ),
          ),
        )

        yield* Ref.update(cache, HashMap.set(attachment.id, text))

        return text
      })

    const transcribe = Effect.fn("Transcriber.transcribe")(function* (message: Inbound.Message) {
      if (Option.isNone(provider)) return Option.none<string>()

      const active = provider.value
      const audio = message.attachments.filter((attachment) => isAudio(attachment) && attachment.size <= Attachments.MAX_BYTES)

      if (audio.length === 0) return Option.none<string>()

      const texts = yield* Effect.forEach(audio, (attachment) => transcribeOne(active, attachment))

      return Option.some(texts.flatMap(Option.toArray).join("\n\n")).pipe(Option.filter((text) => text !== ""))
    })

    return Service.of({ transcribe })
  }),
)

export * as Transcriber from "./Transcriber.ts"
