import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { Access } from "./Access.ts"
import { Activity } from "./Activity.ts"
import { Approvals } from "./Approvals.ts"
import { Conversations } from "./Conversations.ts"
import { Discord } from "./Discord.ts"
import { Fleet } from "./Fleet.ts"
import { Listener } from "./Listener.ts"
import { Places } from "./Places.ts"
import { Recent } from "./Recent.ts"
import { Screen } from "./Screen.ts"
import { Servers } from "./Servers.ts"
import { Settings } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { ToolCalls } from "./ToolCalls.ts"
import { ToolWorker } from "./ToolWorker.ts"
import { WendellConfig } from "./WendellConfig.ts"

const Platform = Layer.mergeAll(BunServices.layer, BunHttpClient.layer, Settings.layer, Activity.layer, Recent.layer, ToolCalls.layer)

const Configuration = Layer.mergeAll(WendellConfig.layer, Servers.layer, Tasks.layer)

const Connections = Layer.mergeAll(Discord.layer, Fleet.layer)

const Domain = Layer.mergeAll(Access.layer).pipe(Layer.provideMerge(Layer.mergeAll(Conversations.layer, Screen.layer)))

const Workers = Layer.mergeAll(Listener.layer, ToolWorker.layer, Approvals.layer).pipe(Layer.provide(Places.layer))

const Main = Workers.pipe(
  Layer.provide(Domain),
  Layer.provide(Connections),
  Layer.provide(Configuration),
  Layer.provide(Platform),
)

BunRuntime.runMain(Layer.launch(Main))
