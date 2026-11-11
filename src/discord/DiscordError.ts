import { Effect, Schema } from "effect"

export class DiscordError extends Schema.TaggedError<DiscordError>()("Discord.DiscordError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Wraps any failure of a Discord call, with the name of the operation. */
export const discordError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(effect, (cause) => new DiscordError({ operation, cause }))
