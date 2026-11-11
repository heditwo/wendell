import { Context, Layer } from "effect"
import { WendellConfig } from "../config/WendellConfig.ts"
import { ConversationSetting } from "./ConversationSetting.ts"

export const Mode = WendellConfig.ApprovalMode

export type Mode = WendellConfig.ApprovalMode

const DEFAULT_MODE: Mode = "review"

/** Set with `/auto`. The server default is `servers.<name>.approvals`. */
export interface Interface extends ConversationSetting.Interface<Mode> {}

export class Service extends Context.Service<Service, Interface>()("wendell/ApprovalModes") {}

export const layer = Layer.effect(
  Service,
  ConversationSetting.make("ApprovalModes", "approvals.json", Mode, (remote) => remote.prefs.approvals ?? DEFAULT_MODE),
)

export * as ApprovalModes from "./ApprovalModes.ts"
