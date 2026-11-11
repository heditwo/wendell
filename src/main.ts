import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { Activity } from "./conversations/Activity.ts"
import { ApprovalModes } from "./modes/ApprovalModes.ts"
import { Approvals } from "./approvals/Approvals.ts"
import { BusyModes } from "./modes/BusyModes.ts"
import { Commands } from "./discord/commands/Commands.ts"
import { Conversations } from "./conversations/Conversations.ts"
import { Discord } from "./discord/Discord.ts"
import { Fleet } from "./opencode/Fleet.ts"
import { Listener } from "./inbound/Listener.ts"
import { Attachments } from "./inbound/Attachments.ts"
import { Memory } from "./memory/Memory.ts"
import { Models } from "./opencode/Models.ts"
import { Places } from "./conversations/Places.ts"
import { Profile } from "./discord/Profile.ts"
import { Recent } from "./inbound/Recent.ts"
import { Recollection } from "./memory/Recollection.ts"
import { Reviewer } from "./approvals/Reviewer.ts"
import { Screen } from "./inbound/Screen.ts"
import { Servers } from "./config/Servers.ts"
import { Settings } from "./config/Settings.ts"
import { Tasks } from "./tasks/Tasks.ts"
import { ToolCalls } from "./tools/ToolCalls.ts"
import { Uploads } from "./tools/Uploads.ts"
import { ToolWorker } from "./tools/ToolWorker.ts"
import { Transcriber } from "./inbound/Transcriber.ts"
import { WendellConfig } from "./config/WendellConfig.ts"

const Platform = Layer.mergeAll(BunServices.layer, BunHttpClient.layer, Settings.layer, Recent.layer, ToolCalls.layer)

const Configuration = Layer.mergeAll(WendellConfig.layer, Servers.layer, Tasks.layer, Activity.layer)

const Connections = Layer.mergeAll(Discord.layer, Fleet.layer)

const Domain = Layer.mergeAll(
  Conversations.layer,
  Screen.layer,
  Reviewer.layer,
  ApprovalModes.layer,
  BusyModes.layer,
  Attachments.layer,
  Uploads.layer,
  Transcriber.layer,
  Profile.layer,
  Recollection.layer,
).pipe(Layer.provideMerge(Layer.mergeAll(Models.layer, Memory.layer)))

const Workers = Layer.mergeAll(Listener.layer, ToolWorker.layer, Approvals.layer, Commands.layer).pipe(
  Layer.provide(Places.layer),
)

const Main = Workers.pipe(
  Layer.provide(Domain),
  Layer.provide(Connections),
  Layer.provide(Configuration),
  Layer.provide(Platform),
)

BunRuntime.runMain(Layer.launch(Main))
