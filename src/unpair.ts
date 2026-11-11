import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Schema } from "effect"
import { ServerName } from "./Ids.ts"
import { Servers } from "./Servers.ts"
import { Settings } from "./Settings.ts"

const program = Effect.gen(function* () {
  const [name] = yield* Schema.decodeUnknownEffect(Schema.Tuple([ServerName]))(Bun.argv.slice(2))
  const servers = yield* Servers.Service
  const removed = yield* servers.remove(name)

  yield* Console.log(removed ? `Removed "${name}".` : `No server named "${name}".`)
})

const Main = Servers.layer.pipe(Layer.provideMerge(Settings.layer), Layer.provideMerge(BunServices.layer))

BunRuntime.runMain(program.pipe(Effect.provide(Main)))
