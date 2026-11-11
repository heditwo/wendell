import { Context, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import path from "node:path"
import { ServerName } from "../shared/Ids.ts"
import { Settings } from "./Settings.ts"

const StoredServer = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  directory: Schema.String,
  pairedAt: Schema.String,
})

const StoredFile = Schema.Struct({
  servers: Schema.Record(Schema.String, StoredServer).check(Schema.isPropertyNames(ServerName)),
})

interface StoredFile extends Schema.Schema.Type<typeof StoredFile> {}

export interface Paired {
  readonly name: ServerName
  readonly url: string
  readonly token: Redacted.Redacted
  readonly directory: string
  readonly pairedAt: string
}

export class InvalidServersFile extends Schema.TaggedError<InvalidServersFile>()("Servers.InvalidServersFile", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<ReadonlyArray<Paired>, InvalidServersFile>
  readonly save: (server: Paired) => Effect.Effect<void, InvalidServersFile>
  readonly remove: (name: ServerName) => Effect.Effect<boolean, InvalidServersFile>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Servers") {}

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredFile))
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(StoredFile))

const toPaired = ([name, stored]: readonly [string, StoredFile["servers"][string]]): Paired => ({
  name: ServerName.make(name),
  url: stored.url,
  token: Redacted.make(stored.token),
  directory: stored.directory,
  pairedAt: stored.pairedAt,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const fs = yield* FileSystem.FileSystem
    const file = settings.serversFile
    const invalid = (cause: unknown) => new InvalidServersFile({ path: file, cause })

    const read = Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return { servers: {} }

      return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeFile))
    }).pipe(Effect.mapError(invalid))

    const write = (contents: StoredFile) =>
      Effect.gen(function* () {
        const json = yield* encodeFile(contents)

        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, `${json}\n`, { mode: 0o600 })
        yield* fs.chmod(file, 0o600)
      }).pipe(Effect.mapError(invalid))

    const list = Effect.fn("Servers.list")(function* () {
      const contents = yield* read

      return Object.entries(contents.servers).map(toPaired)
    })

    const save = Effect.fn("Servers.save")(function* (server: Paired) {
      const contents = yield* read

      yield* write({
        servers: {
          ...contents.servers,
          [server.name]: {
            url: server.url,
            token: Redacted.value(server.token),
            directory: server.directory,
            pairedAt: server.pairedAt,
          },
        },
      })
    })

    const remove = Effect.fn("Servers.remove")(function* (name: ServerName) {
      const contents = yield* read
      const { [name]: removed, ...rest } = contents.servers

      if (removed === undefined) return false

      yield* write({ servers: rest })

      return true
    })

    return Service.of({ list, save, remove })
  }),
)

export const find = (servers: ReadonlyArray<Paired>, name: ServerName) =>
  Option.fromNullishOr(servers.find((server) => server.name === name))

export * as Servers from "./Servers.ts"
