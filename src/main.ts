import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { Approvals } from "./approvals/Approvals.ts"
import { Reviewer } from "./approvals/Reviewer.ts"
import { Servers } from "./config/Servers.ts"
import { Settings } from "./config/Settings.ts"
import { WendellConfig } from "./config/WendellConfig.ts"
import { Activity } from "./conversations/Activity.ts"
import { Conversations } from "./conversations/Conversations.ts"
import { Places } from "./conversations/Places.ts"
import { Commands } from "./discord/commands/Commands.ts"
import { Discord } from "./discord/Discord.ts"
import { Profile } from "./discord/Profile.ts"
import { Attachments } from "./inbound/Attachments.ts"
import { Listener } from "./inbound/Listener.ts"
import { Recent } from "./inbound/Recent.ts"
import { Screen } from "./inbound/Screen.ts"
import { Transcriber } from "./inbound/Transcriber.ts"
import { Memory } from "./memory/Memory.ts"
import { Recollection } from "./memory/Recollection.ts"
import { ApprovalModes } from "./modes/ApprovalModes.ts"
import { BusyModes } from "./modes/BusyModes.ts"
import { Fleet } from "./opencode/Fleet.ts"
import { Models } from "./opencode/Models.ts"
import { Tasks } from "./tasks/Tasks.ts"
import { ToolCalls } from "./tools/ToolCalls.ts"
import { ToolWorker } from "./tools/ToolWorker.ts"
import { Uploads } from "./tools/Uploads.ts"

// The runtime, environment settings and the in-process tool call queue.
const Platform = Layer.mergeAll(BunServices.layer, BunHttpClient.layer, Settings.layer, Recent.layer, ToolCalls.layer)

// Files on this machine: wendell.json, the paired servers, and records in .data/.
const Stores = Layer.mergeAll(WendellConfig.layer, Servers.layer, Tasks.layer, Activity.layer)

// The two outside connections: Discord and the paired OpenCode servers.
const Connections = Layer.mergeAll(Discord.layer, Fleet.layer)

// Model choices and long-term memory, which most services read.
const Knowledge = Layer.mergeAll(Models.layer, Memory.layer)

const Services = Layer.mergeAll(
  // Sessions and turns
  Conversations.layer,
  // Incoming messages
  Screen.layer,
  Attachments.layer,
  Transcriber.layer,
  Recollection.layer,
  // Approvals and per-conversation modes
  Reviewer.layer,
  ApprovalModes.layer,
  BusyModes.layer,
  // Tool support and Wendell's profile
  Uploads.layer,
  Profile.layer,
).pipe(Layer.provideMerge(Knowledge))

// Long-running loops that react to Discord and OpenCode events.
const Workers = Layer.mergeAll(Listener.layer, ToolWorker.layer, Approvals.layer, Commands.layer).pipe(
  Layer.provide(Places.layer),
)

const Main = Workers.pipe(
  Layer.provide(Services),
  Layer.provide(Connections),
  Layer.provide(Stores),
  Layer.provide(Platform),
)

BunRuntime.runMain(Layer.launch(Main))
