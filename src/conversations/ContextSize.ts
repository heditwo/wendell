import type { OpenCodeClient, Session } from "@opencode/client/effect"
import { Effect, Option } from "effect"

/**
 * The context size of a session's latest answer: its input, output and cache tokens.
 * None when there is no answer yet, or when a compaction came after it, because its count is then out of date.
 */
export const of = Effect.fn("ContextSize.of")(function* (client: OpenCodeClient, sessionID: Session.ID) {
  const page = yield* client.message.list({ sessionID, order: "desc", limit: 5 })
  const last = page.data.find((message) => message.type === "assistant" || message.type === "compaction")

  if (last === undefined || last.type !== "assistant" || last.tokens === undefined) return Option.none<number>()

  const { input, output, cache } = last.tokens

  return Option.some(input + output + cache.read + cache.write)
})

export * as ContextSize from "./ContextSize.ts"
