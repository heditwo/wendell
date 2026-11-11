import { Effect, Option } from "effect"
import { Conversations } from "../../conversations/Conversations.ts"
import { Places } from "../../conversations/Places.ts"
import { Models } from "../../opencode/Models.ts"
import type { Discord } from "../Discord.ts"
import { Command } from "./Command.ts"

/** `/models`: shows the model of this conversation and the server default. */
export const make = Effect.gen(function* () {
  const places = yield* Places.Service
  const models = yield* Models.Service
  const conversations = yield* Conversations.Service

  const describe = Effect.fn("ModelsCommand.describe")(function* (place: Places.Place, model: Option.Option<string>) {
    if (Option.isNone(model)) return "the agent's default"

    const { remote, directory } = place.conversation
    const catalog = yield* models.catalog(remote, directory).pipe(Effect.orElseSucceed(() => []))
    const found = catalog.find((candidate) => model.value.split("#")[0] === Models.key(candidate))

    return found === undefined ? `\`${model.value}\`` : `**${found.name}** (\`${model.value}\`)`
  })

  const answer = (call: Discord.CommandCall) =>
    Effect.gen(function* () {
      const place = yield* places.forOrigin(Command.origin(call))
      const current = yield* conversations.currentModel(place.conversation)
      const fallback = yield* models.defaultFor(place.conversation.remote)

      return [
        `This conversation: ${yield* describe(place, current)}`,
        `Default for ${place.conversation.remote.name}: ${yield* describe(place, fallback)}`,
      ].join("\n")
    }).pipe(Command.orReply("Could not show the models", "I could not read the models. Try again."))

  return {
    spec: { name: "models", description: "Show the model of this conversation and the server default.", options: [] },
    ephemeral: () => true,
    answer,
    autocomplete: Option.none(),
  } satisfies Command.Command
})

export * as ModelsCommand from "./ModelsCommand.ts"
