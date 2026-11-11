import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { ChannelId, GuildId, RoleId, ServerName, UserId } from "./Ids.ts"
import { Settings } from "./Settings.ts"

export const Goal = Schema.Struct({
  wakeWhen: Schema.NonEmptyString,
  engagement: Schema.NonEmptyString,
})

export interface Goal extends Schema.Schema.Type<typeof Goal> {}

export const ServerPrefs = Schema.Struct({
  agent: Schema.optional(Schema.NonEmptyString),
  model: Schema.optional(Schema.NonEmptyString),
  allow: Schema.optional(Schema.Array(Schema.NonEmptyString)),
})

export interface ServerPrefs extends Schema.Schema.Type<typeof ServerPrefs> {}

export const Channel = Schema.Struct({
  server: Schema.optional(ServerName),
  goal: Schema.optional(Goal),
})

export interface Channel extends Schema.Schema.Type<typeof Channel> {}

/** Who gets full power (shell and edits in task threads) in a Discord server. */
export const Access = Schema.Union([
  Schema.Literals(["everyone", "administrators"]),
  Schema.Struct({ role: RoleId }),
])

export type Access = typeof Access.Type

export const Guild = Schema.Struct({
  access: Schema.optional(Access),
})

export interface Guild extends Schema.Schema.Type<typeof Guild> {}

export const File = Schema.Struct({
  defaultServer: Schema.optional(ServerName),
  owners: Schema.optional(Schema.Array(UserId)),
  defaultAccess: Schema.optional(Access),
  guilds: Schema.optional(
    Schema.Record(Schema.String, Guild).check(
      Schema.isPropertyNames(GuildId, { message: "Every key in guilds must be a Discord server ID" }),
    ),
  ),
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
  readonly owners: ReadonlyArray<UserId>
  readonly accessFor: (guildId: GuildId) => Access
  readonly serverPrefs: (name: ServerName) => ServerPrefs
  readonly channel: (channelId: ChannelId) => Option.Option<Channel>
}

export class Service extends Context.Service<Service, Interface>()("wendell/WendellConfig") {}

export class InvalidConfigFile extends Schema.TaggedError<InvalidConfigFile>()("WendellConfig.InvalidConfigFile", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export const describeGoal = (goal: Goal) =>
  ["You listen to this channel for this goal:", goal.wakeWhen, goal.engagement].join("\n")

export const fromFile = (file: File): Interface => ({
  defaultServer: Option.fromUndefinedOr(file.defaultServer),
  owners: file.owners ?? [],
  accessFor: (guildId) => file.guilds?.[guildId]?.access ?? file.defaultAccess ?? "everyone",
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
