import { Effect, Option, Schema } from "effect"
import path from "node:path"
import { Settings } from "../config/Settings.ts"
import type { Fleet } from "../opencode/Fleet.ts"
import { ChannelId } from "../shared/Ids.ts"
import { JsonStore } from "../shared/JsonStore.ts"
import { Tasks } from "../tasks/Tasks.ts"

const MAX_PARENTS = 8

export interface Interface<Value> {
  /** The conversation's own value, then its parent tasks' values, then the server default. */
  readonly modeFor: (remote: Fleet.Remote, channelId: ChannelId) => Effect.Effect<Value>
  readonly set: (channelId: ChannelId, value: Value) => Effect.Effect<void, JsonStore.StoreError>
}

/**
 * A value that people set per conversation with a slash command, kept in `.data/<file>`.
 * `name` prefixes the spans, for example "BusyModes".
 */
export const make = <Value>(
  name: string,
  file: string,
  value: Schema.Codec<Value>,
  serverDefault: (remote: Fleet.Remote) => Value,
) =>
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const tasks = yield* Tasks.Service

    const StoredFile = Schema.Struct({
      conversations: Schema.Record(Schema.String, value).check(Schema.isPropertyNames(ChannelId)),
    })

    const store = yield* JsonStore.make(StoredFile, path.join(settings.dataDirectory, file), { conversations: {} })

    const modeFor = Effect.fn(`${name}.modeFor`)(function* (remote: Fleet.Remote, channelId: ChannelId) {
      const { conversations } = yield* store.get
      let current = Option.some(channelId)

      // Sub-tasks follow their parent task until someone sets their own value.
      for (let depth = 0; depth < MAX_PARENTS && Option.isSome(current); depth += 1) {
        const own = conversations[current.value]

        if (own !== undefined) return own

        const task = yield* tasks.get(current.value)

        current = Option.flatMap(task, (found) => Option.fromUndefinedOr(found.parentTaskId))
      }

      return serverDefault(remote)
    })

    const set = Effect.fn(`${name}.set`)(function* (channelId: ChannelId, mode: Value) {
      yield* store.update((current) => ({ conversations: { ...current.conversations, [channelId]: mode } }))
    })

    return { modeFor, set } satisfies Interface<Value>
  })

export * as ConversationSetting from "./ConversationSetting.ts"
