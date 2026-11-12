import { Effect, FileSystem } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Provider } from "../transcription/Provider.ts"
import type { VoiceConfig } from "./VoiceConfig.ts"

const SIDECAR_DEPENDENCY = "voice/node_modules/@discordjs/voice/package.json"

/** The `bun run doctor` lines for voice: the sidecar's runtime and dependencies, and the speech server. */
export const checks = Effect.fn("VoiceCheck.checks")(function* (config: VoiceConfig.Resolved) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const http = yield* HttpClient.HttpClient
  const [program] = config.sidecar

  const runs = yield* spawner.exitCode(ChildProcess.make(program, ["--version"])).pipe(
    Effect.map((code) => code === 0),
    Effect.orElseSucceed(() => false),
  )

  const installed = yield* fs.exists(SIDECAR_DEPENDENCY).pipe(Effect.orElseSucceed(() => false))

  const health = yield* http.execute(HttpClientRequest.get(`${config.tts.url}/health`)).pipe(
    Effect.map((response) => response.status),
    Effect.orElseSucceed(() => 0),
  )

  return [
    { label: "voice sidecar", ok: runs, detail: config.sidecar.join(" ") },
    {
      label: "voice dependencies",
      ok: installed,
      detail: installed ? "voice/node_modules" : "missing, run `cd voice && npm ci`",
    },
    {
      label: "voice speech server",
      ok: health >= 200 && health < 300,
      detail: health === 0 ? `cannot reach ${config.tts.url}` : `${config.tts.url}/health (HTTP ${health}), voice ${config.tts.voice}`,
    },
  ] satisfies ReadonlyArray<Provider.Check>
})

export * as VoiceCheck from "./VoiceCheck.ts"
