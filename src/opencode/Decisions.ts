import type { Model } from "@opencode/client/effect"
import { Effect, Option } from "effect"
import { WendellConfig } from "../config/WendellConfig.ts"
import type { Discord } from "../discord/Discord.ts"
import type { Fleet } from "./Fleet.ts"

/** The decision model must not run on a server that blocks its provider. */
export const isBlocked = (remote: Fleet.Remote, model: Model.Ref) =>
  WendellConfig.isBlocked(remote.prefs, `${model.providerID}/${model.id}`)

/** One line of a conversation transcript for the decision model. */
export const line = (message: Discord.TranscriptLine, maxChars: number) =>
  `${message.isMe ? "Wendell (agent)" : message.authorName}: ${message.content.slice(0, maxChars)}`

/** Asks the decision model one yes or no question, named `name`, about `input`. None when it gives no answer. */
export const probability = Effect.fn("Decisions.probability")(function* (
  remote: Fleet.Remote,
  model: Model.Ref,
  input: string,
  name: string,
  instructions: string,
) {
  const result = yield* remote.client.experimental.generate.decisions({
    model,
    input: [{ type: "text", text: input }],
    questions: [{ type: "predicate", name, instructions }],
  })

  return Option.fromNullishOr(result.answers.find((answer) => answer.name === name)).pipe(
    Option.flatMap((answer) => (answer.type === "predicate" ? Option.some(answer.probability) : Option.none())),
  )
})

/** Asks several yes or no questions about `input` in one call. Returns each answered question's probability by name. */
export const probabilities = Effect.fn("Decisions.probabilities")(function* (
  remote: Fleet.Remote,
  model: Model.Ref,
  input: string,
  questions: ReadonlyArray<{ readonly name: string; readonly instructions: string }>,
) {
  const result = yield* remote.client.experimental.generate.decisions({
    model,
    input: [{ type: "text", text: input }],
    questions: questions.map((question) => ({ type: "predicate" as const, name: question.name, instructions: question.instructions })),
  })

  return new Map(result.answers.flatMap((answer) => (answer.type === "predicate" ? [[answer.name, answer.probability] as const] : [])))
})

export * as Decisions from "./Decisions.ts"
