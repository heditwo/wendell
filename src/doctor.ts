import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { Agent } from "@opencode/client/effect"
import { Console, Effect, Layer, Option } from "effect"
import { Fleet } from "./Fleet.ts"
import { Servers } from "./Servers.ts"
import { Settings } from "./Settings.ts"
import { WendellConfig } from "./WendellConfig.ts"

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

  yield* Option.match(Option.fromUndefinedOr(prefs.model), {
    onNone: () => check(label("model"), true, "agent default (set servers.<name>.model to pick a cheaper one)"),
    onSome: (model) => check(label("model"), hasModel(model), model),
  })

  const decision = `${settings.decisionModel.providerID}/${settings.decisionModel.id}`

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
    label("screen"),
    Option.isNone(screen),
    Option.match(screen, {
      onNone: () => decision,
      onSome: (message) => `${decision} failed, so the screen fails open: ${message}`,
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
})

const Main = Layer.mergeAll(Servers.layer, WendellConfig.layer).pipe(
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunHttpClient.layer)),
)

BunRuntime.runMain(program.pipe(Effect.provide(Main)))
