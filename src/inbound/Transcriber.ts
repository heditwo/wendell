import { Context, Duration, Effect, FileSystem, HashMap, Layer, Option, Ref, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import path from "node:path"
import { Files } from "../shared/Files.ts"
import { Attachments } from "./Attachments.ts"
import type { Inbound } from "./Inbound.ts"
import { WendellConfig } from "../config/WendellConfig.ts"

const TIMEOUT = Duration.minutes(3)
const AUDIO_EXTENSIONS = new Set([".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".webm", ".flac", ".aac"])

// voxtype prints its progress on stdout, before the transcript.
const STATUS_LINE = /^(Loading audio file:|Audio format:|Processing \d+ samples)/

export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()("Transcriber.TranscriptionError", {
  step: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Interface {
  /**
   * The text of the message's voice messages and audio files, transcribed on this machine.
   * None when there is no audio or transcription is off. Never fails; results are cached per attachment.
   */
  readonly transcribe: (message: Inbound.Message) => Effect.Effect<Option.Option<string>>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Transcriber") {}

export const isAudio = (attachment: Inbound.Attachment) =>
  Option.exists(attachment.contentType, (type) => type.toLowerCase().startsWith("audio/")) ||
  AUDIO_EXTENSIONS.has(path.extname(attachment.name).toLowerCase())

export const cleanOutput = (output: string) =>
  output
    .split("\n")
    .filter((line) => !STATUS_LINE.test(line.trim()))
    .join("\n")
    .trim()

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* WendellConfig.Service
    const fs = yield* FileSystem.FileSystem
    const http = yield* HttpClient.HttpClient
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const cache = yield* Ref.make(HashMap.empty<string, Option.Option<string>>())

    const failed = (step: string) => (cause: unknown) => new TranscriptionError({ step, cause })

    const run = Effect.fn("Transcriber.run")(function* (
      command: readonly [string, ...Array<string>],
      attachment: Inbound.Attachment,
    ) {
      const response = yield* http
        .execute(HttpClientRequest.get(attachment.url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.mapError(failed("download")))

      const data = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.mapError(failed("download"))))
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "wendell-voice-" }).pipe(Effect.mapError(failed("temp")))
      const input = path.join(directory, `input${path.extname(Files.safeName(attachment.name)) || ".audio"}`)
      const wav = path.join(directory, "speech.wav")

      yield* fs.writeFile(input, data).pipe(Effect.mapError(failed("temp")))

      const converted = yield* spawner
        .exitCode(ChildProcess.make("ffmpeg", ["-loglevel", "error", "-nostdin", "-y", "-i", input, "-ar", "16000", "-ac", "1", wav]))
        .pipe(Effect.mapError(failed("ffmpeg")))

      if (converted !== 0) return yield* new TranscriptionError({ step: "ffmpeg", cause: `exit code ${converted}` })

      const [program, ...args] = command

      const output = yield* spawner
        .string(ChildProcess.make(program, args.map((arg) => arg.replaceAll("{file}", wav))))
        .pipe(Effect.mapError(failed("transcribe")))

      return Option.some(cleanOutput(output)).pipe(Option.filter((text) => text !== ""))
    }, Effect.scoped)

    const transcribeOne = (command: readonly [string, ...Array<string>], attachment: Inbound.Attachment) =>
      Effect.gen(function* () {
        const cached = HashMap.get(yield* Ref.get(cache), attachment.id)

        if (Option.isSome(cached)) return cached.value

        const text = yield* run(command, attachment).pipe(
          Effect.timeout(TIMEOUT),
          Effect.tap((result) => Effect.logInfo("Transcribed a voice message", { attachment: attachment.id, words: Option.match(result, { onNone: () => 0, onSome: (value) => value.split(/\s+/).length }) })),
          Effect.catch((cause) =>
            Effect.logWarning("Could not transcribe a voice message", { attachment: attachment.id, cause }).pipe(
              Effect.as(Option.none<string>()),
            ),
          ),
        )

        yield* Ref.update(cache, HashMap.set(attachment.id, text))

        return text
      })

    const transcribe = Effect.fn("Transcriber.transcribe")(function* (message: Inbound.Message) {
      const command = config.transcribeCommand

      if (Option.isNone(command)) return Option.none<string>()

      const audio = message.attachments.filter((attachment) => isAudio(attachment) && attachment.size <= Attachments.MAX_BYTES)

      if (audio.length === 0) return Option.none<string>()

      const texts = yield* Effect.forEach(audio, (attachment) => transcribeOne(command.value, attachment))

      return Option.some(texts.flatMap(Option.toArray).join("\n\n")).pipe(Option.filter((text) => text !== ""))
    })

    return Service.of({ transcribe })
  }),
)

export * as Transcriber from "./Transcriber.ts"
