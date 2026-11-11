import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { ChannelId, ServerName } from "./Ids.ts"
import { Settings } from "./Settings.ts"

export const Goal = Schema.Struct({
  wakeWhen: Schema.NonEmptyString,
  engagement: Schema.NonEmptyString,
})

export interface Goal extends Schema.Schema.Type<typeof Goal> {}

/**
 * - `off`: every permission request gets approval buttons.
 * - `review`: the decision model approves requests that clearly follow from the conversation; the rest get buttons.
 * - `auto`: every request is approved.
 */
export const ApprovalMode = Schema.Literals(["off", "review", "auto"])

export type ApprovalMode = typeof ApprovalMode.Type

export const ServerPrefs = Schema.Struct({
  agent: Schema.optional(Schema.NonEmptyString),
  model: Schema.optional(Schema.NonEmptyString),
  allow: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /** Approval mode for conversations without their own. Default: `review`. */
  approvals: Schema.optional(ApprovalMode),
  /** Provider IDs that Wendell must never use on this server, such as a work account. */
  blockedProviders: Schema.optional(Schema.Array(Schema.NonEmptyString)),
})

export interface ServerPrefs extends Schema.Schema.Type<typeof ServerPrefs> {}

export const Channel = Schema.Struct({
  server: Schema.optional(ServerName),
  goal: Schema.optional(Goal),
})

export interface Channel extends Schema.Schema.Type<typeof Channel> {}

/** Local speech-to-text for voice messages. The command gets a 16 kHz mono WAV file in place of `{file}`. */
export const Transcription = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  command: Schema.optional(Schema.NonEmptyArray(Schema.NonEmptyString)),
})

export interface Transcription extends Schema.Schema.Type<typeof Transcription> {}

export const DEFAULT_TRANSCRIBE_COMMAND: readonly [string, ...Array<string>] = ["voxtype", "-q", "transcribe", "{file}"]

export const File = Schema.Struct({
  defaultServer: Schema.optional(ServerName),
  hideSessions: Schema.optional(Schema.Boolean),
  transcription: Schema.optional(Transcription),
  servers: Schema.optional(
    Schema.Record(Schema.String, ServerPrefs).check(
      Schema.isPropertyNames(ServerName, { message: "Every key in servers must be a paired server name" }),
    ),
  ),
  channels: Schema.optional(
    Schema.Record(Schema.String, Channel).check(
      Schema.isPropertyNames(ChannelId, { message: "Every key in channels must be a Discord channel ID" }),
    ),
  ),
})

export interface File extends Schema.Schema.Type<typeof File> {}

export interface Interface {
  readonly defaultServer: Option.Option<ServerName>
  /** Archive Wendell's sessions, so the OpenCode desktop does not list them. */
  readonly hideSessions: boolean
  /** The speech-to-text command, or none when transcription is off. */
  readonly transcribeCommand: Option.Option<readonly [string, ...Array<string>]>
  readonly serverPrefs: (name: ServerName) => ServerPrefs
  readonly channel: (channelId: ChannelId) => Option.Option<Channel>
}

export class Service extends Context.Service<Service, Interface>()("wendell/WendellConfig") {}

export class InvalidConfigFile extends Schema.TaggedError<InvalidConfigFile>()("WendellConfig.InvalidConfigFile", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export const providerOf = (model: string) => model.slice(0, Math.max(model.indexOf("/"), 0))

export const isBlocked = (prefs: ServerPrefs, model: string) => (prefs.blockedProviders ?? []).includes(providerOf(model))

export const describeGoal = (goal: Goal) =>
  ["You listen to this channel for this goal:", goal.wakeWhen, goal.engagement].join("\n")

export const fromFile = (file: File): Interface => ({
  defaultServer: Option.fromUndefinedOr(file.defaultServer),
  hideSessions: file.hideSessions ?? true,
  transcribeCommand:
    file.transcription?.enabled === false
      ? Option.none()
      : Option.some(file.transcription?.command ?? DEFAULT_TRANSCRIBE_COMMAND),
  serverPrefs: (name) => file.servers?.[name] ?? {},
  channel: (channelId) => Option.fromNullishOr(file.channels?.[channelId]),
})

export const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(File))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(settings.configFile).pipe(Effect.orDie)

    if (!exists) {
      yield* Effect.logWarning("No config file. Wendell uses the first paired server and answers only when addressed.", {
        path: settings.configFile,
      })

      return Service.of(fromFile({}))
    }

    const file = yield* fs.readFileString(settings.configFile).pipe(
      Effect.flatMap(decode),
      Effect.mapError((cause) => new InvalidConfigFile({ path: settings.configFile, cause })),
    )

    yield* Effect.logInfo("Loaded config", {
      servers: Object.keys(file.servers ?? {}).length,
      channels: Object.keys(file.channels ?? {}).length,
    })

    return Service.of(fromFile(file))
  }),
)

export * as WendellConfig from "./WendellConfig.ts"
