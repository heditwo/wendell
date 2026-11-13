import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { Agent } from "@opencode/client/effect"
import { Console, Effect, Layer, Option } from "effect"
import { Servers } from "../config/Servers.ts"
import { Settings } from "../config/Settings.ts"
import { WendellConfig } from "../config/WendellConfig.ts"
import { SpeechToText } from "../transcription/SpeechToText.ts"
import { Fleet } from "../opencode/Fleet.ts"
import { Silence } from "../voice/Silence.ts"
import { VoiceCheck } from "../voice/VoiceCheck.ts"

const check = (label: string, ok: boolean, detail: string) => Console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`)

const checkServer = Effect.fn("doctor.checkServer")(function* (server: Servers.Paired) {
  const settings = yield* Settings.Service
  const config = yield* WendellConfig.Service
  const prefs = config.serverPrefs(server.name)
  const client = yield* Fleet.connect(server)
  const label = (what: string) => `${server.name} ${what}`

  const info = yield* client.server.info().pipe(Effect.option)

  yield* check(
    label("server"),
    Option.isSome(info),
    Option.match(info, {
      onNone: () => `cannot reach ${server.url}, or the token expired. Pair again.`,
      onSome: (value) => `OpenCode ${value.version} on ${value.hostname ?? server.url}`,
    }),
  )

  if (Option.isNone(info)) return

  const location = yield* client.location.get({ location: { directory: server.directory } }).pipe(Effect.option)

  yield* check(label("directory"), Option.isSome(location), server.directory)

  const agent = Option.fromUndefinedOr(prefs.agent)

  if (Option.isSome(agent)) {
    const found = yield* client.agent.get({ agentID: Agent.ID.make(agent.value) }).pipe(Effect.option)

    yield* check(label("agent"), Option.isSome(found), agent.value)
  } else {
    yield* check(label("agent"), true, "server default")
  }

  const models = yield* client.model.list({ location: { directory: server.directory } }).pipe(Effect.option)

  const hasModel = (ref: string) =>
    Option.exists(models, (list) => list.data.some((model) => `${model.providerID}/${model.id}` === ref && model.enabled))

  const blocked = prefs.blockedProviders ?? []

  yield* Option.match(Option.fromUndefinedOr(prefs.model), {
    onNone: () =>
      blocked.length > 0
        ? check(label("model"), false, "not set, so Wendell cannot start sessions while providers are blocked")
        : check(label("model"), true, "agent default (set servers.<name>.model to pick a cheaper one)"),
    onSome: (model) =>
      WendellConfig.isBlocked(prefs, model)
        ? check(label("model"), false, `${model} uses a blocked provider (${WendellConfig.providerOf(model)})`)
        : check(label("model"), hasModel(model), model),
  })

  yield* check(label("blocked"), true, blocked.join(", ") || "no blocked providers")

  // A subagent with its own model ignores the session's model.
  const agents = yield* client.agent.list({ location: { directory: server.directory } }).pipe(Effect.option)

  const blockedSubagents = Option.match(agents, {
    onNone: () => [],
    onSome: (list) =>
      list.data.flatMap((agent) => {
        const model = agent.model === undefined ? undefined : `${agent.model.providerID}/${agent.model.id}`

        return agent.mode !== "primary" && model !== undefined && WendellConfig.isBlocked(prefs, model)
          ? [`${agent.id} (${model})`]
          : []
      }),
  })

  if (blocked.length > 0) {
    yield* check(
      label("subagents"),
      blockedSubagents.length === 0,
      blockedSubagents.length === 0
        ? "no subagent has its own model on a blocked provider"
        : `these subagents use a blocked provider: ${blockedSubagents.join(", ")}`,
    )
  }

  const decision = `${settings.decisionModel.providerID}/${settings.decisionModel.id}`

  if (WendellConfig.isBlocked(prefs, decision)) {
    yield* check(label("decision model"), false, `${decision} uses a blocked provider, so Wendell does not filter messages that do not address him`)

    return yield* check(label("allow"), true, (prefs.allow ?? []).join(", ") || "nothing beyond the defaults")
  }

  const screen = yield* client.experimental.generate
    .decisions({
      model: settings.decisionModel,
      input: [{ type: "text", text: "Ada: does anyone know how to fix the build?" }],
      questions: [{ type: "predicate", name: "probe", instructions: "Is this a question?" }],
    })
    .pipe(
      Effect.map(() => Option.none<string>()),
      Effect.catch((error) => Effect.succeed(Option.some("message" in error ? error.message : String(error)))),
    )

  yield* check(
    label("decision model"),
    Option.isNone(screen),
    Option.match(screen, {
      onNone: () => decision,
      onSome: (message) => `${decision} failed, so Wendell does not filter messages that do not address him: ${message}`,
    }),
  )

  yield* check(label("allow"), true, (prefs.allow ?? []).join(", ") || "nothing beyond the defaults")
})

const program = Effect.gen(function* () {
  const servers = yield* Servers.Service
  const config = yield* WendellConfig.Service
  const paired = yield* servers.list()

  yield* check("servers", paired.length > 0, paired.length > 0 ? paired.map((server) => server.name).join(", ") : "none, run `bun run pair`")
  yield* check(
    "default",
    true,
    Option.getOrElse(config.defaultServer, () => paired[0]?.name ?? "none"),
  )
  yield* Effect.forEach(paired, checkServer, { discard: true })
  yield* checkTranscription
  yield* checkVoice
})

const checkTranscription = Effect.gen(function* () {
  const provider = yield* SpeechToText.Service

  if (Option.isNone(provider)) return yield* check("transcription", true, "off")

  yield* check("transcription", true, provider.value.name)

  const results = yield* provider.value.check

  yield* Effect.forEach(results, (result) => check(result.label, result.ok, result.detail), { discard: true })

  const probe = yield* Silence.probe(provider.value).pipe(
    Effect.as(Option.none<string>()),
    Effect.catch((error) => Effect.succeed(Option.some(Silence.describe(error)))),
  )

  yield* check(
    "transcription test",
    Option.isNone(probe),
    Option.match(probe, {
      onNone: () => "transcribed one second of silence",
      onSome: (cause) => `could not transcribe one second of silence (${cause})`,
    }),
  )
})

const checkVoice = Effect.gen(function* () {
  const config = yield* WendellConfig.Service
  const provider = yield* SpeechToText.Service

  if (Option.isNone(config.voice)) return yield* check("voice", true, "off")

  yield* check("voice", Option.isSome(provider), Option.isSome(provider) ? "on" : "on, but transcription is off, so Wendell does not hear calls")

  const results = yield* VoiceCheck.checks(config.voice.value)

  yield* Effect.forEach(results, (result) => check(result.label, result.ok, result.detail), { discard: true })
})

const Main = Layer.mergeAll(Servers.layer, SpeechToText.layer.pipe(Layer.provideMerge(WendellConfig.layer))).pipe(
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunHttpClient.layer)),
)

BunRuntime.runMain(program.pipe(Effect.provide(Main)))
