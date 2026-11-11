import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { OpenCode } from "@opencode/client/effect"
import { Console, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect"
import path from "node:path"
import { Pairing } from "../config/Pairing.ts"
import { Servers } from "../config/Servers.ts"
import { Settings } from "../config/Settings.ts"
import { Fleet } from "../opencode/Fleet.ts"
import { ServerName } from "../shared/Ids.ts"

const USAGE = "Usage: bun run pair <name> <pairing link> <directory on the server>"

class PairError extends Schema.TaggedError<PairError>()("Pair.PairError", {
  message: Schema.String,
}) {}

const Args = Schema.Tuple([ServerName, Schema.NonEmptyString, Schema.NonEmptyString])

const program = Effect.gen(function* () {
  const [name, link, directory] = yield* Schema.decodeUnknownEffect(Args)(Bun.argv.slice(2)).pipe(
    Effect.mapError(() => new PairError({ message: USAGE })),
  )

  if (!path.isAbsolute(directory)) {
    return yield* new PairError({ message: "The directory must be an absolute path on the server." })
  }

  const { baseUrl, code } = yield* Pairing.parseLink(link).pipe(
    Effect.mapError((error) => new PairError({ message: error.message })),
  )

  const anonymous = yield* OpenCode.make({ baseUrl })

  const session = yield* anonymous.server
    .connect({ code })
    .pipe(Effect.mapError(() => new PairError({ message: "The pairing link was rejected. Links work once and expire in 5 minutes." })))

  const server: Servers.Paired = {
    name,
    url: baseUrl,
    token: Redacted.make(session.token),
    directory,
    pairedAt: DateTime.formatIso(yield* DateTime.now),
  }

  const client = yield* Fleet.connect(server)
  const info = yield* client.server.info()

  yield* client.location.get({ location: { directory } }).pipe(
    Effect.mapError(
      () =>
        new PairError({
          message: `The server cannot open ${directory}. Create the directory on ${info.hostname ?? "the server"} first.`,
        }),
    ),
  )

  const servers = yield* Servers.Service
  const existing = Servers.find(yield* servers.list(), name)

  yield* servers.save(server)
  yield* Console.log(
    `${Option.isSome(existing) ? "Re-paired" : "Paired"} "${name}": OpenCode ${info.version} on ${info.hostname ?? baseUrl}.`,
  )
  yield* Console.log(`Wendell's sessions on this server work in ${directory}.`)
})

const Main = Servers.layer.pipe(
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunHttpClient.layer)),
)

BunRuntime.runMain(
  program.pipe(
    Effect.catchTag("Pair.PairError", (error) => Console.error(error.message).pipe(Effect.andThen(Effect.fail(error)))),
    Effect.provide(Main),
  ),
  { disableErrorReporting: true },
)
