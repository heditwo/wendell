import { Config, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { WendellConfig } from "../config/WendellConfig.ts"
import { Provider } from "./Provider.ts"

const Response = Schema.Struct({ text: Schema.String })

const failed = (step: string) => (cause: unknown) => new Provider.TranscriptionError({ step, cause })

/** Calls an OpenAI-compatible transcription endpoint: a local server such as speaches or LocalAI, or a hosted API. */
export const make = Effect.fn("OpenAIProvider.make")(function* (config: WendellConfig.OpenAITranscription) {
  const http = yield* HttpClient.HttpClient
  const base = config.url.replace(/\/+$/, "")

  const apiKey = yield* Option.match(Option.fromUndefinedOr(config.apiKeyEnv), {
    onNone: () => Effect.succeed(Option.none<Redacted.Redacted>()),
    onSome: (name) => Config.Redacted(name).pipe(Config.option),
  })

  const authorized = (request: HttpClientRequest.HttpClientRequest) =>
    Option.match(apiKey, { onNone: () => request, onSome: (key) => HttpClientRequest.bearerToken(request, key) })

  const transcribe = Effect.fn("OpenAIProvider.transcribe")(function* (audio: Provider.Audio) {
    const form = new FormData()
    const type = Option.getOrElse(audio.contentType, () => "application/octet-stream")

    form.append("file", new File([audio.data], audio.name, { type }))
    form.append("model", config.model)

    if (config.language !== undefined) form.append("language", config.language)

    const request = HttpClientRequest.post(`${base}/audio/transcriptions`).pipe(HttpClientRequest.bodyFormData(form), authorized)

    const response = yield* http.execute(request).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.mapError(failed("request")))

    const body = yield* HttpClientResponse.schemaBodyJson(Response)(response).pipe(Effect.mapError(failed("response")))

    return body.text.trim()
  })

  const check = http.execute(authorized(HttpClientRequest.get(`${base}/models`))).pipe(
    Effect.map((response): ReadonlyArray<Provider.Check> => [
      { label: "transcription endpoint", ok: response.status < 400, detail: `${base} (HTTP ${response.status}), model ${config.model}` },
    ]),
    Effect.orElseSucceed((): ReadonlyArray<Provider.Check> => [
      { label: "transcription endpoint", ok: false, detail: `cannot reach ${base}` },
    ]),
  )

  return { name: `openai: ${base}`, transcribe, check } satisfies Provider.Provider
})

export * as OpenAIProvider from "./OpenAIProvider.ts"
