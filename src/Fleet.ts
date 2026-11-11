import { AbsolutePath, OpenCode, type OpenCodeClient } from "@opencode/client/effect"
import { type ClientMcpConnection, connectClientMcp } from "@opencode/client/mcp"
import { Context, Effect, HashMap, Layer, Option, Redacted, Ref, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import path from "node:path"
import { ClientTools } from "./ClientTools.ts"
import type { ServerName } from "./Ids.ts"
import { Policy } from "./Policy.ts"
import { Servers } from "./Servers.ts"
import { ToolCalls } from "./ToolCalls.ts"
import { WendellConfig } from "./WendellConfig.ts"

export interface Remote {
  readonly name: ServerName
  readonly url: string
  /** Wendell's root directory on the server. Channels work here; tasks get subdirectories. */
  readonly directory: AbsolutePath
  readonly client: OpenCodeClient
  readonly prefs: WendellConfig.ServerPrefs
}

export interface Interface {
  readonly remotes: ReadonlyArray<Remote>
  readonly byName: (name: ServerName) => Option.Option<Remote>
  readonly fallback: Remote
  /** Makes Wendell's Discord tools available to sessions in `directory`. Tools are scoped to one location. */
  readonly attach: (remote: Remote, directory: AbsolutePath) => Effect.Effect<void>
  readonly makeDirectory: (remote: Remote, directory: AbsolutePath) => Effect.Effect<void, ServerRequestError>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Fleet") {}

export class NoServers extends Schema.TaggedError<NoServers>()("Fleet.NoServers", {
  message: Schema.String,
}) {}

export class ServerUnreachable extends Schema.TaggedError<ServerUnreachable>()("Fleet.ServerUnreachable", {
  name: Schema.String,
  url: Schema.String,
  cause: Schema.Defect(),
}) {}

export class ServerRequestError extends Schema.TaggedError<ServerRequestError>()("Fleet.ServerRequestError", {
  server: Schema.String,
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export const authorization = (token: Redacted.Redacted) => `Basic ${btoa(`opencode:${Redacted.value(token)}`)}`

const authed = (http: HttpClient.HttpClient, token: Redacted.Redacted) =>
  HttpClient.mapRequest(http, HttpClientRequest.setHeader("authorization", authorization(token)))

/** An Effect client for one paired server. Requires an `HttpClient`. */
export const connect = Effect.fn("Fleet.connect")(function* (server: Servers.Paired) {
  const http = yield* HttpClient.HttpClient

  return yield* OpenCode.make({ baseUrl: server.url }).pipe(
    Effect.provideService(HttpClient.HttpClient, authed(http, server.token)),
  )
})

const MARKER = ".wendell"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const servers = yield* Servers.Service
    const config = yield* WendellConfig.Service
    const toolCalls = yield* ToolCalls.Service
    const http = yield* HttpClient.HttpClient
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    const connections = yield* Ref.make(HashMap.empty<string, ClientMcpConnection>())
    const attaching = yield* Semaphore.make(1)
    const tokens = new Map<ServerName, Redacted.Redacted>()
    const created = yield* Ref.make(HashMap.empty<string, true>())

    yield* Effect.addFinalizer(() =>
      Ref.get(connections).pipe(
        Effect.flatMap((all) =>
          Effect.forEach(HashMap.values(all), (connection) => Effect.promise(() => connection.close()), {
            discard: true,
          }),
        ),
      ),
    )

    const attach = Effect.fn("Fleet.attach")(function* (remote: Remote, directory: AbsolutePath) {
      const key = `${remote.name}:${directory}`
      const token = tokens.get(remote.name)

      if (token === undefined) return

      yield* Effect.gen(function* () {
        if (HashMap.has(yield* Ref.get(connections), key)) return

        const connection = connectClientMcp({
          url: remote.url,
          name: Policy.CLIENT_NAME,
          directory,
          headers: { authorization: authorization(token) },
          tools: ClientTools.make(remote.name, toolCalls, run),
        })

        yield* Ref.update(connections, HashMap.set(key, connection))
        yield* Effect.logDebug("Attached Wendell's tools", { server: remote.name, directory })
      }).pipe(Semaphore.withPermits(attaching, 1))
    })

    const makeDirectory = Effect.fn("Fleet.makeDirectory")(
      function* (remote: Remote, directory: AbsolutePath) {
        const key = `${remote.name}:${directory}`

        if (HashMap.has(yield* Ref.get(created), key)) return

        const token = tokens.get(remote.name)

        if (token === undefined) return

        const url = new URL(`${remote.url}/api/experimental/fs/write`)

        url.searchParams.set("location[directory]", remote.directory)
        url.searchParams.set("path", path.join(directory, MARKER))

        const request = HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyText("Created by Wendell.\n", "application/octet-stream"),
        )

        yield* authed(http, token).execute(request).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))
        yield* Ref.update(created, HashMap.set(key, true))
      },
      (effect, remote) =>
        Effect.mapError(
          effect,
          (cause) => new ServerRequestError({ server: remote.name, operation: "Fleet.makeDirectory", cause }),
        ),
    )

    const start = Effect.fn("Fleet.start")(function* (server: Servers.Paired) {
      const client = yield* connect(server)
      const info = yield* client.server.info()

      yield* client.location.get({ location: { directory: server.directory } })

      tokens.set(server.name, server.token)

      const remote: Remote = {
        name: server.name,
        url: server.url,
        directory: AbsolutePath.make(server.directory),
        client,
        prefs: config.serverPrefs(server.name),
      }

      yield* Effect.logInfo("Connected to OpenCode server", {
        server: server.name,
        url: server.url,
        version: info.version,
        directory: server.directory,
      })

      return remote
    })

    const paired = yield* servers.list()

    const remotes = yield* Effect.forEach(
      paired,
      (server) =>
        start(server).pipe(
          Effect.mapError((cause) => new ServerUnreachable({ name: server.name, url: server.url, cause })),
          Effect.tapError((error) => Effect.logError("Could not connect to OpenCode server", error)),
          Effect.option,
        ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((results) => results.flatMap(Option.toArray)))

    const byName = (name: ServerName) => Option.fromNullishOr(remotes.find((remote) => remote.name === name))

    const fallback = Option.flatMap(config.defaultServer, byName).pipe(
      Option.orElse(() => Option.fromNullishOr(remotes[0])),
    )

    if (Option.isNone(fallback)) {
      return yield* new NoServers({
        message:
          paired.length === 0
            ? "No paired OpenCode servers. Run `bun run pair <name> <link> <directory>`."
            : "None of the paired OpenCode servers is reachable.",
      })
    }

    yield* Effect.forEach(remotes, (remote) => attach(remote, remote.directory), { discard: true })

    return Service.of({ remotes, byName, fallback: fallback.value, attach, makeDirectory })
  }),
)

export * as Fleet from "./Fleet.ts"
