import { Effect, Option } from "effect"
import { WendellConfig } from "../../config/WendellConfig.ts"
import { Conversations } from "../../conversations/Conversations.ts"
import { Places } from "../../conversations/Places.ts"
import { Fleet } from "../../opencode/Fleet.ts"
import { Models } from "../../opencode/Models.ts"
import type { ToolCalls } from "../../tools/ToolCalls.ts"
import type { Discord } from "../Discord.ts"
import { Command } from "./Command.ts"

const SCOPES: ReadonlyArray<{ readonly name: string; readonly value: ToolCalls.ModelScope }> = [
  { name: "this conversation", value: "conversation" },
  { name: "server default", value: "default" },
]

export const make = Effect.gen(function* () {
  const places = yield* Places.Service
  const models = yield* Models.Service
  const conversations = yield* Conversations.Service
  const fleet = yield* Fleet.Service

  // Autocomplete must answer within 3 seconds, so load the model lists before anyone types.
  yield* Effect.forEach(fleet.remotes, (remote) => models.catalog(remote, remote.directory).pipe(Effect.ignore), {
    discard: true,
  }).pipe(Effect.forkScoped)

  const answer = (call: Discord.CommandCall) =>
    Effect.gen(function* () {
      const place = yield* places.forOrigin(Command.origin(call))
      const { remote, directory } = place.conversation
      const resolved = yield* models.resolve(remote, directory, Option.getOrElse(Command.option(call, "model"), () => ""))
      const name = `**${resolved.name}** (\`${resolved.id}\`)`

      if (Option.getOrElse(Command.option(call, "scope"), () => "conversation") === "default") {
        yield* models.setDefault(remote, resolved.id)

        return `Default model for ${remote.name}: ${name}`
      }

      yield* conversations.setModel(place.conversation, resolved)

      return `Model for this conversation: ${name}`
    }).pipe(
      Effect.catchTag("Models.UnknownModel", (error) => Effect.succeed(error.message)),
      Command.orReply("Could not change the model", "I could not change the model. Try again."),
    )

  // Models of the providers in use here come first.
  const autocomplete = (call: Discord.CommandCall, query: string) =>
    Effect.gen(function* () {
      const place = yield* places.forOrigin(Command.origin(call))
      const current = yield* conversations.currentModel(place.conversation).pipe(Effect.orElseSucceed(() => Option.none<string>()))
      const fallback = yield* models.defaultFor(place.conversation.remote)

      const preferred = [...new Set([...Option.toArray(current), ...Option.toArray(fallback)].map(WendellConfig.providerOf))]

      const found = yield* models.search(place.conversation.remote, place.conversation.directory, query, Command.MAX_CHOICES, preferred)

      return found.map((model): Discord.Choice => ({ name: `${model.name} · ${Models.key(model)}`, value: Models.key(model) }))
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not list models for autocomplete", { cause }).pipe(Effect.as([]))),
    )

  return {
    spec: {
      name: "model",
      description: "Change the model that Wendell uses.",
      options: [
        { name: "model", description: "Model, as provider/model.", required: true, autocomplete: true, choices: [] },
        {
          name: "scope",
          description: "Where the model applies. Default: this conversation.",
          required: false,
          autocomplete: false,
          choices: SCOPES,
        },
      ],
    },
    ephemeral: () => false,
    answer,
    autocomplete: Option.some(autocomplete),
  } satisfies Command.Command
})

export * as ModelCommand from "./ModelCommand.ts"
