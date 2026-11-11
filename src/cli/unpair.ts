import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Schema } from "effect"
import { Servers } from "../config/Servers.ts"
import { Settings } from "../config/Settings.ts"
import { ServerName } from "../shared/Ids.ts"

const program = Effect.gen(function* () {
  const [name] = yield* Schema.decodeUnknownEffect(Schema.Tuple([ServerName]))(Bun.argv.slice(2))
  const servers = yield* Servers.Service
  const removed = yield* servers.remove(name)

  yield* Console.log(removed ? `Removed "${name}".` : `No server named "${name}".`)
})

const Main = Servers.layer.pipe(Layer.provideMerge(Settings.layer), Layer.provideMerge(BunServices.layer))

BunRuntime.runMain(program.pipe(Effect.provide(Main)))
