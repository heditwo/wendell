import { Context, Effect, Layer, Option } from "effect"
import { WendellConfig } from "../config/WendellConfig.ts"
import { ConversationSetting } from "./ConversationSetting.ts"

/** Set with `/context limit:`. The server default is `servers.<name>.contextLimit`, then `contextLimit`. `0` is off. */
export interface Interface extends ConversationSetting.Interface<number> {}

export class Service extends Context.Service<Service, Interface>()("wendell/ContextLimits") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* WendellConfig.Service

    return yield* ConversationSetting.make("ContextLimits", "context.json", WendellConfig.ContextLimit, (remote) =>
      Option.getOrElse(config.contextLimit(remote.name), () => 0),
    )
  }),
)

export * as ContextLimits from "./ContextLimits.ts"
