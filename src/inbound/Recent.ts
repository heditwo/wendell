import { Context, Effect, HashMap, Layer, Option, Ref } from "effect"
import type { MessageId } from "../shared/Ids.ts"
import type { Inbound } from "./Inbound.ts"

const CAPACITY = 2_000

export interface Interface {
  readonly record: (message: Inbound.Message) => Effect.Effect<void>
  readonly get: (messageId: MessageId) => Effect.Effect<Option.Option<Inbound.Message>>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Recent") {}

/** Recent human messages, so tools can find who asked for something by message ID. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make({ byId: HashMap.empty<MessageId, Inbound.Message>(), order: new Array<MessageId>() })

    const record = Effect.fn("Recent.record")(function* (message: Inbound.Message) {
      yield* Ref.update(state, ({ byId, order }) => {
        const nextOrder = [...order, message.id]
        const evicted = nextOrder.length > CAPACITY ? nextOrder.slice(0, nextOrder.length - CAPACITY) : []
        const kept = evicted.length > 0 ? nextOrder.slice(evicted.length) : nextOrder

        return {
          byId: HashMap.removeMany(HashMap.set(byId, message.id, message), evicted),
          order: kept,
        }
      })
    })

    const get = Effect.fn("Recent.get")(function* (messageId: MessageId) {
      return HashMap.get((yield* Ref.get(state)).byId, messageId)
    })

    return Service.of({ record, get })
  }),
)

export * as Recent from "./Recent.ts"
