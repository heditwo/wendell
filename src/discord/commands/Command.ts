import { Effect, Option } from "effect"
import type { Places } from "../../conversations/Places.ts"
import type { Discord } from "../Discord.ts"

/** Discord shows at most 25 autocomplete choices. */
export const MAX_CHOICES = 25

/** A slash command. The registry defers first, because Discord expects an answer within 3 seconds. */
export interface Command {
  readonly spec: Discord.CommandSpec
  /** Only the person who called the command sees the answer. */
  readonly ephemeral: (call: Discord.CommandCall) => boolean
  /** The answer text. Never fails: failures become a short apology. */
  readonly answer: (call: Discord.CommandCall) => Effect.Effect<string>
  /** Choices for the focused option while someone types. */
  readonly autocomplete: Option.Option<(call: Discord.CommandCall, query: string) => Effect.Effect<ReadonlyArray<Discord.Choice>>>
}

export const option = (call: Discord.CommandCall, name: string) =>
  Option.fromNullishOr(call.options.find((candidate) => candidate.name === name)).pipe(Option.map((found) => found.value))

/** The text that the person is typing in the focused option. */
export const query = (call: Discord.CommandCall) =>
  Option.fromNullishOr(call.options.find((candidate) => candidate.focused)).pipe(
    Option.map((focused) => focused.value),
    Option.getOrElse(() => ""),
  )

export const origin = (call: Discord.CommandCall): Places.Origin => ({
  channelId: call.channelId,
  guildId: call.member.guildId,
  authorId: call.member.userId,
  authorName: call.userName,
})

/** Logs a failure and answers `reply` instead. */
export const orReply =
  (log: string, reply: string) =>
  <E>(effect: Effect.Effect<string, E>) =>
    effect.pipe(Effect.catch((cause) => Effect.logWarning(log, { cause }).pipe(Effect.as(reply))))

export * as Command from "./Command.ts"
