import { Effect, Option } from "effect"
import { ContextSize } from "../../conversations/ContextSize.ts"
import { Places } from "../../conversations/Places.ts"
import { ContextLimits } from "../../modes/ContextLimits.ts"
import { SessionKey } from "../../opencode/SessionKey.ts"
import type { Discord } from "../Discord.ts"
import { Command } from "./Command.ts"

const MIN_LIMIT = 20_000

const SCALES = new Map([
  ["k", 1_000],
  ["m", 1_000_000],
])

const formatTokens = (tokens: number) => (tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`)

/** "256k", "256000", "1m", "off" or "0" → tokens; none when it is not a size. */
export const parseLimit = (text: string): Option.Option<number> => {
  const value = text.trim().toLowerCase().replaceAll(/[\s,_]/g, "")

  if (value === "off" || value === "0") return Option.some(0)

  const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(value)

  if (match === null) return Option.none()

  const scale = SCALES.get(match[2] ?? "") ?? 1

  return Option.some(Math.round(Number(match[1]) * scale))
}

const describeLimit = (limit: number) =>
  limit === 0 ? "off (OpenCode compacts by itself near the model's limit)" : `${formatTokens(limit)} tokens`

/** `/context`: the conversation's context size and limit, a new limit, or a compaction now. */
export const make = Effect.gen(function* () {
  const places = yield* Places.Service
  const limits = yield* ContextLimits.Service

  const answer = (call: Discord.CommandCall) =>
    Effect.gen(function* () {
      const place = yield* places.forOrigin(Command.origin(call))
      const { remote, channelId } = place.conversation
      const sessionID = SessionKey.forChannel(channelId)
      const requested = Command.option(call, "limit")

      if (Option.isSome(requested)) {
        const limit = parseLimit(requested.value)

        if (Option.isNone(limit)) return 'That is not a size. Use for example "256k", "200000" or "off".'

        if (limit.value !== 0 && limit.value < MIN_LIMIT) return `The limit must be at least ${formatTokens(MIN_LIMIT)} tokens, or "off".`

        yield* limits.set(channelId, limit.value)

        return `Context limit here: ${describeLimit(limit.value)}. I compact this conversation when it reaches it.`
      }

      if (Option.isSome(Command.option(call, "compact"))) {
        yield* remote.client.session.compact({ sessionID })
        yield* Effect.logInfo("Compacted a session on request", { server: remote.name, channelId })

        return "Compacting this conversation now. I keep a summary and the most recent messages."
      }

      const size = yield* ContextSize.of(remote.client, sessionID).pipe(Effect.orElseSucceed(() => Option.none<number>()))
      const limit = yield* limits.modeFor(remote, channelId)

      const now = Option.match(size, {
        onNone: () => "no answer since the last compaction yet",
        onSome: (tokens) => `${formatTokens(tokens)} tokens`,
      })

      return [`Context here: ${now}.`, `Limit: ${describeLimit(limit)}.`].join("\n")
    }).pipe(Command.orReply("Could not answer /context", "I could not read this conversation's context. Try again."))

  return {
    spec: {
      name: "context",
      description: "Show this conversation's context size and limit, change the limit, or compact it now.",
      options: [
        {
          name: "limit",
          description: 'New limit for this conversation, for example "256k", "200000" or "off".',
          required: false,
          autocomplete: false,
          choices: [],
        },
        {
          name: "compact",
          description: "Compact this conversation now.",
          required: false,
          autocomplete: false,
          choices: [{ name: "now", value: "now" }],
        },
      ],
    },
    ephemeral: (call) => Option.isNone(Command.option(call, "limit")) && Option.isNone(Command.option(call, "compact")),
    answer,
    autocomplete: Option.none(),
  } satisfies Command.Command
})

export * as ContextCommand from "./ContextCommand.ts"
