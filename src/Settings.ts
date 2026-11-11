import { Model, Provider } from "@opencode/client/effect"
import { Config, Context, Duration, Effect, Layer, Schema } from "effect"
import path from "node:path"

export interface Interface {
  readonly dataDirectory: string
  readonly serversFile: string
  readonly configFile: string
  readonly personaFile: string
  readonly decisionModel: Model.Ref
  readonly skipBelow: number
  readonly approveAbove: number
  readonly batchWindow: Duration.Duration
  readonly followWindow: Duration.Duration
}

export class Service extends Context.Service<Service, Interface>()("wendell/Settings") {}

export class InvalidSetting extends Schema.TaggedError<InvalidSetting>()("Settings.InvalidSetting", {
  name: Schema.String,
  message: Schema.String,
}) {}

export const parseModelRef = (name: string, value: string): Effect.Effect<Model.Ref, InvalidSetting> => {
  const separator = value.indexOf("/")

  if (separator <= 0 || separator === value.length - 1) {
    return Effect.fail(new InvalidSetting({ name, message: `Expected "provider/model", received "${value}"` }))
  }

  return Effect.succeed({
    providerID: Provider.ID.make(value.slice(0, separator)),
    id: Model.ID.make(value.slice(separator + 1)),
  })
}

const absolute = (value: string) => path.resolve(value)

export const config = Config.all({
  dataDirectory: Config.String("WENDELL_DATA_DIR").pipe(Config.withDefault(".data"), Config.map(absolute)),
  configFile: Config.String("WENDELL_CONFIG").pipe(Config.withDefault("wendell.json"), Config.map(absolute)),
  personaFile: Config.String("WENDELL_PERSONA").pipe(Config.withDefault("persona.md"), Config.map(absolute)),
  decisionModel: Config.String("WENDELL_DECISION_MODEL").pipe(Config.withDefault("opencode/jev-1.13")),
  skipBelow: Config.Number("WENDELL_SKIP_BELOW").pipe(Config.withDefault(0.2)),
  approveAbove: Config.Number("WENDELL_APPROVE_ABOVE").pipe(Config.withDefault(0.85)),
  batchWindow: Config.Duration("WENDELL_BATCH_WINDOW").pipe(Config.withDefault(Duration.seconds(3))),
  followWindow: Config.Duration("WENDELL_FOLLOW_WINDOW").pipe(Config.withDefault(Duration.minutes(10))),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* config
    const decisionModel = yield* parseModelRef("WENDELL_DECISION_MODEL", settings.decisionModel)

    return Service.of({
      ...settings,
      serversFile: path.join(settings.dataDirectory, "servers.json"),
      decisionModel,
    })
  }),
)

export * as Settings from "./Settings.ts"
