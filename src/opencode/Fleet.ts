import { AbsolutePath, OpenCode, type OpenCodeClient, Project } from "@opencode/client/effect"
import { type ClientMcpConnection, connectClientMcp } from "@opencode/client/mcp"
import { Context, Effect, HashMap, Layer, Option, Redacted, Ref, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import path from "node:path"
import { Servers } from "../config/Servers.ts"
import { WendellConfig } from "../config/WendellConfig.ts"
import type { ServerName } from "../shared/Ids.ts"
import { ClientTools } from "../tools/ClientTools.ts"
import { ToolCalls } from "../tools/ToolCalls.ts"
import { Policy } from "./Policy.ts"

export interface Remote {
  readonly name: ServerName
  readonly url: string
  /** Wendell's root directory on the server. Channels work here; tasks get subdirectories. */
  readonly directory: AbsolutePath
  /** The server's temporary directory, where tools such as `image_generate` save their files. */
  readonly tmp: AbsolutePath
  readonly client: OpenCodeClient
  readonly prefs: WendellConfig.ServerPrefs
  /** Optional server features, found when Wendell connects. */
  readonly capabilities: Capabilities
}

export interface Capabilities {
  /** The `image_generate` tool exists: an enabled image model, and the tool is on. */
  readonly imageGeneration: boolean
}

// From this version on, `image_generate` is on whenever an image model is available.
const IMAGE_TOOL_BY_DEFAULT = [2, 2, 2] as const

const versionAtLeast = (version: string, minimum: ReadonlyArray<number>) => {
  const parts = version.split(/[.-]/).map((part) => Number.parseInt(part, 10))

  for (const [index, wanted] of minimum.entries()) {
    const actual = parts[index] ?? 0

    if (Number.isNaN(actual) || actual !== wanted) return !Number.isNaN(actual) && actual > wanted
  }

  return true
}

export interface Interface {
  readonly remotes: ReadonlyArray<Remote>
  readonly byName: (name: ServerName) => Option.Option<Remote>
  readonly fallback: Remote
  /** Makes Wendell's Discord tools available to sessions in `directory`. Tools are scoped to one location. */
  readonly attach: (remote: Remote, directory: AbsolutePath) => Effect.Effect<void>
  readonly makeDirectory: (remote: Remote, directory: AbsolutePath) => Effect.Effect<void, ServerRequestError>
  /** Writes a file on the server, which may be another machine. Creates missing parent directories. */
  readonly writeFile: (remote: Remote, file: AbsolutePath, data: Uint8Array) => Effect.Effect<void, ServerRequestError>
  /** Reads `relative` inside `root` on the server. The server refuses paths outside `root`. */
  readonly readFile: (
    remote: Remote,
    root: AbsolutePath,
    relative: string,
    maxBytes: number,
  ) => Effect.Effect<Uint8Array<ArrayBuffer>, ServerRequestError | FileTooLarge>
  /**
   * When `directory` is inside a git repository, creates a worktree of it named `name` and returns
   * the same directory inside the worktree. Returns none when there is no repository.
   */
  readonly worktree: (
    remote: Remote,
    directory: AbsolutePath,
    name: string,
  ) => Effect.Effect<Option.Option<AbsolutePath>, ServerRequestError>
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

export class FileTooLarge extends Schema.TaggedError<FileTooLarge>()("Fleet.FileTooLarge", {
  path: Schema.String,
  size: Schema.Number,
  limit: Schema.Number,
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

    const requestError = (remote: Remote, operation: string) => (cause: unknown) =>
      new ServerRequestError({ server: remote.name, operation, cause })

    const tokenFor = (remote: Remote, operation: string) =>
      Option.match(Option.fromUndefinedOr(tokens.get(remote.name)), {
        onNone: () => Effect.fail(new ServerRequestError({ server: remote.name, operation, cause: "The server is not connected." })),
        onSome: Effect.succeed,
      })

    const writeFile = Effect.fn("Fleet.writeFile")(function* (remote: Remote, file: AbsolutePath, data: Uint8Array) {
      const token = yield* tokenFor(remote, "Fleet.writeFile")
      const url = new URL(`${remote.url}/api/experimental/fs/write`)

      url.searchParams.set("location[directory]", remote.directory)
      url.searchParams.set("path", file)

      const request = HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUint8Array(data, "application/octet-stream"))

      yield* authed(http, token)
        .execute(request)
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.mapError(requestError(remote, "Fleet.writeFile")))
    })

    const readFile = Effect.fn("Fleet.readFile")(function* (
      remote: Remote,
      root: AbsolutePath,
      relative: string,
      maxBytes: number,
    ) {
      const token = yield* tokenFor(remote, "Fleet.readFile")
      const encoded = relative.split("/").map(encodeURIComponent).join("/")
      const url = new URL(`${remote.url}/api/fs/read/${encoded}`)

      url.searchParams.set("location[directory]", root)

      const response = yield* authed(http, token)
        .execute(HttpClientRequest.get(url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.mapError(requestError(remote, "Fleet.readFile")))

      const declared = Number(response.headers["content-length"] ?? "0")

      if (declared > maxBytes) return yield* new FileTooLarge({ path: relative, size: declared, limit: maxBytes })

      const body = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.mapError(requestError(remote, "Fleet.readFile"))))

      if (body.byteLength > maxBytes) return yield* new FileTooLarge({ path: relative, size: body.byteLength, limit: maxBytes })

      return body
    })

    const makeDirectory = Effect.fn("Fleet.makeDirectory")(function* (remote: Remote, directory: AbsolutePath) {
      const key = `${remote.name}:${directory}`

      if (HashMap.has(yield* Ref.get(created), key)) return

      yield* writeFile(remote, AbsolutePath.make(path.join(directory, MARKER)), new TextEncoder().encode("Created by Wendell.\n"))
      yield* Ref.update(created, HashMap.set(key, true))
    })

    const worktree = Effect.fn("Fleet.worktree")(
      function* (remote: Remote, directory: AbsolutePath, name: string) {
        const { project } = yield* remote.client.location.get({ location: { directory } })

        if (project.id === Project.ID.global) return Option.none<AbsolutePath>()

        // The server caches the project's repository state. Without a refresh, a repository that the task
        // created after its first visit is "not found".
        yield* remote.client.worktree.refresh({ projectID: project.id })

        const vcs = yield* remote.client.vcs.get({ location: { directory } })

        const created = yield* remote.client.worktree.create({ projectID: project.id, name }).pipe(
          Effect.map(Option.some),
          Effect.catchTag("WorktreeError", (error) =>
            vcs.data.provider === "git" ? Effect.fail(error) : Effect.succeed(Option.none<{ readonly directory: string }>()),
          ),
        )

        return Option.map(created, (worktree) =>
          AbsolutePath.make(path.join(worktree.directory, path.relative(project.directory, directory))),
        )
      },
      (effect, remote) =>
        Effect.mapError(effect, (cause) => new ServerRequestError({ server: remote.name, operation: "Fleet.worktree", cause })),
    )

    const imageGeneration = Effect.fn("Fleet.imageGeneration")(function* (
      client: OpenCodeClient,
      version: string,
      directory: AbsolutePath,
    ) {
      const images = yield* client.model.list({ location: { directory }, types: ["image"] })

      if (!images.data.some((model) => model.enabled)) return false

      if (versionAtLeast(version, IMAGE_TOOL_BY_DEFAULT)) return true

      const entries = yield* client.config.get({ location: { directory } })

      return entries.some((entry) => entry.type === "document" && Boolean(entry.info.experimental?.image_generate))
    }, Effect.orElseSucceed(() => false))

    const start = Effect.fn("Fleet.start")(function* (server: Servers.Paired) {
      const client = yield* connect(server)
      const info = yield* client.server.info()

      yield* client.location.get({ location: { directory: server.directory } })

      tokens.set(server.name, server.token)

      const remote: Remote = {
        name: server.name,
        url: server.url,
        directory: AbsolutePath.make(server.directory),
        tmp: AbsolutePath.make(info.paths.tmp),
        client,
        prefs: config.serverPrefs(server.name),
        capabilities: {
          imageGeneration: yield* imageGeneration(client, info.version, AbsolutePath.make(server.directory)),
        },
      }

      yield* Effect.logInfo("Connected to OpenCode server", {
        server: server.name,
        url: server.url,
        version: info.version,
        directory: server.directory,
        imageGeneration: remote.capabilities.imageGeneration,
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

    return Service.of({ remotes, byName, fallback: fallback.value, attach, makeDirectory, writeFile, readFile, worktree })
  }),
)

export * as Fleet from "./Fleet.ts"
