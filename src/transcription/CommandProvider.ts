import { Effect, FileSystem } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import path from "node:path"
import type { WendellConfig } from "../config/WendellConfig.ts"
import { Files } from "../shared/Files.ts"
import { Provider } from "./Provider.ts"

const failed = (step: string) => (cause: unknown) => new Provider.TranscriptionError({ step, cause })

/** Keeps the lines that do not match any of `ignore`. */
export const cleanOutput = (output: string, ignore: ReadonlyArray<RegExp>) =>
  output
    .split("\n")
    .filter((line) => !ignore.some((pattern) => pattern.test(line.trim())))
    .join("\n")
    .trim()

/** Runs a speech-to-text program on this machine. */
export const make = Effect.fn("CommandProvider.make")(function* (config: WendellConfig.CommandTranscription) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const convert = config.convert ?? true
  const ignore = (config.ignoreLines ?? []).map((pattern) => new RegExp(pattern))
  const [program, ...args] = config.command

  const succeeds = (command: string, commandArgs: ReadonlyArray<string>) =>
    spawner.exitCode(ChildProcess.make(command, commandArgs)).pipe(
      Effect.map((code) => code === 0),
      Effect.orElseSucceed(() => false),
    )

  const transcribe = Effect.fn("CommandProvider.transcribe")(function* (audio: Provider.Audio) {
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "wendell-voice-" }).pipe(Effect.mapError(failed("temp")))
    const input = path.join(directory, `input${path.extname(Files.safeName(audio.name)) || ".audio"}`)

    yield* fs.writeFile(input, audio.data).pipe(Effect.mapError(failed("temp")))

    const file = convert ? path.join(directory, "speech.wav") : input

    if (convert) {
      const converted = yield* spawner
        .exitCode(ChildProcess.make("ffmpeg", ["-loglevel", "error", "-nostdin", "-y", "-i", input, "-ar", "16000", "-ac", "1", file]))
        .pipe(Effect.mapError(failed("ffmpeg")))

      if (converted !== 0) return yield* new Provider.TranscriptionError({ step: "ffmpeg", cause: `exit code ${converted}` })
    }

    const output = yield* spawner
      .string(ChildProcess.make(program, args.map((arg) => arg.replaceAll("{file}", file))))
      .pipe(Effect.mapError(failed(program)))

    return cleanOutput(output, ignore)
  }, Effect.scoped)

  const check = Effect.gen(function* () {
    const checks = new Array<Provider.Check>()

    if (convert) {
      checks.push({ label: "transcription ffmpeg", ok: yield* succeeds("ffmpeg", ["-version"]), detail: "converts voice messages to WAV" })
    }

    checks.push({ label: `transcription ${program}`, ok: yield* succeeds(program, ["--help"]), detail: config.command.join(" ") })

    return checks
  })

  return { name: `command: ${program}`, transcribe, check } satisfies Provider.Provider
})

export * as CommandProvider from "./CommandProvider.ts"
