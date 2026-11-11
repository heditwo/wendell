import { Context, Layer } from "effect"
import { WendellConfig } from "../config/WendellConfig.ts"
import { ConversationSetting } from "./ConversationSetting.ts"

export const Mode = WendellConfig.BusyMode

export type Mode = WendellConfig.BusyMode

const DEFAULT_MODE: Mode = "interrupt"

/** Set with `/busy`. The server default is `servers.<name>.busy`. */
export interface Interface extends ConversationSetting.Interface<Mode> {}

export class Service extends Context.Service<Service, Interface>()("wendell/BusyModes") {}

export const layer = Layer.effect(
  Service,
  ConversationSetting.make("BusyModes", "busy.json", Mode, (remote) => remote.prefs.busy ?? DEFAULT_MODE),
)

export * as BusyModes from "./BusyModes.ts"
