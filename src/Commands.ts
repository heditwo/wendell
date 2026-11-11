import { Effect, Layer, Option, Stream } from "effect"
import { Access } from "./Access.ts"
import { Conversations } from "./Conversations.ts"
import { Discord } from "./Discord.ts"
import { Fleet } from "./Fleet.ts"
import { Models } from "./Models.ts"
import { Places } from "./Places.ts"
import type { ToolCalls } from "./ToolCalls.ts"

const MAX_CHOICES = 25

const SCOPES: ReadonlyArray<{ readonly name: string; readonly value: ToolCalls.ModelScope }> = [
  { name: "this conversation", value: "conversation" },
  { name: "server default", value: "default" },
]

const specs: ReadonlyArray<Discord.CommandSpec> = [
  {
    name: "model",
    description: "Change the model that Wendell uses.",
    options: [
      { name: "model", description: "Model, as provider/model.", required: true, autocomplete: true, choices: [] },
      { name: "scope", description: "Where the model applies. Default: this conversation.", required: false, autocomplete: false, choices: SCOPES },
    ],
  },
  { name: "models", description: "Show the model of this conversation and the server default.", options: [] },
]

const option = (call: Discord.CommandCall, name: string) =>
  Option.fromNullishOr(call.options.find((candidate) => candidate.name === name)).pipe(Option.map((found) => found.value))

const origin = (call: Discord.CommandCall): Places.Origin => ({
  channelId: call.channelId,
  guildId: call.member.guildId,
  member: call.member,
  authorId: call.member.userId,
  authorName: call.userName,
})

/** `/model` and `/models`: change and show the models of Wendell's conversations. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const discord = yield* Discord.Service
    const access = yield* Access.Service
    const places = yield* Places.Service
    const models = yield* Models.Service
    const conversations = yield* Conversations.Service
    const fleet = yield* Fleet.Service

    const describe = Effect.fn("Commands.describe")(function* (place: Places.Place, model: Option.Option<string>) {
      if (Option.isNone(model)) return "the agent's default"

      const { remote, directory } = place.conversation
      const catalog = yield* models.catalog(remote, directory).pipe(Effect.orElseSucceed(() => []))
      const found = catalog.find((candidate) => model.value.split("#")[0] === Models.key(candidate))

      return found === undefined ? `\`${model.value}\`` : `**${found.name}** (\`${model.value}\`)`
    })

    const changeModel = Effect.fn("Commands.changeModel")(function* (call: Discord.CommandCall) {
      if (!(yield* access.trusted(call.member))) {
        return yield* discord.answerCommand(call, "Only people with access to Wendell's tools can change the model.", true)
      }

      const scope = Option.getOrElse(option(call, "scope"), () => "conversation")

      yield* discord.deferCommand(call, false)

      const answer = yield* Effect.gen(function* () {
        const place = yield* places.forOrigin(origin(call))
        const { remote, directory } = place.conversation
        const resolved = yield* models.resolve(remote, directory, Option.getOrElse(option(call, "model"), () => ""))
        const name = `**${resolved.name}** (\`${resolved.id}\`)`

        if (scope === "default") {
          yield* models.setDefault(remote, resolved.id)

          return `Default model for ${remote.name}: ${name}`
        }

        yield* conversations.setModel(place.conversation, resolved)

        return `Model for this conversation: ${name}`
      }).pipe(
        Effect.catchTag("Models.UnknownModel", (error) => Effect.succeed(error.message)),
        Effect.catch((cause) =>
          Effect.logWarning("Could not change the model", { cause }).pipe(Effect.as("I could not change the model. Try again.")),
        ),
      )

      yield* discord.editCommandAnswer(call, answer)
    })

    const showModels = Effect.fn("Commands.showModels")(function* (call: Discord.CommandCall) {
      yield* discord.deferCommand(call, true)

      const answer = yield* Effect.gen(function* () {
        const place = yield* places.forOrigin(origin(call))
        const current = yield* conversations.currentModel(place.conversation)
        const fallback = yield* models.defaultFor(place.conversation.remote)

        return [
          `This conversation: ${yield* describe(place, current)}`,
          `Default for ${place.conversation.remote.name}: ${yield* describe(place, fallback)}`,
        ].join("\n")
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not show the models", { cause }).pipe(Effect.as("I could not read the models. Try again.")),
        ),
      )

      yield* discord.editCommandAnswer(call, answer)
    })

    const command = (call: Discord.CommandCall) => {
      if (call.name === "model") return changeModel(call)

      if (call.name === "models") return showModels(call)

      return Effect.void
    }

    const autocomplete = Effect.fn("Commands.autocomplete")(function* (call: Discord.CommandCall) {
      const query = Option.fromNullishOr(call.options.find((candidate) => candidate.focused)).pipe(
        Option.map((focused) => focused.value),
        Option.getOrElse(() => ""),
      )

      const choices = yield* Effect.gen(function* () {
        if (!(yield* access.trusted(call.member))) return []

        const place = yield* places.forOrigin(origin(call))
        const found = yield* models.search(place.conversation.remote, place.conversation.directory, query, MAX_CHOICES)

        return found.map((model) => ({ name: `${model.name} · ${Models.key(model)}`, value: Models.key(model) }))
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not list models for autocomplete", { cause }).pipe(Effect.as([])),
        ),
      )

      yield* discord.answerAutocomplete(call, choices)
    })

    const handle = (stream: Stream.Stream<Discord.CommandCall>, run: (call: Discord.CommandCall) => Effect.Effect<void, Discord.DiscordError>) =>
      stream.pipe(
        Stream.runForEach((call) =>
          run(call).pipe(
            Effect.catch((cause) => Effect.logWarning("Could not answer a slash command", { command: call.name, cause })),
            Effect.forkScoped,
          ),
        ),
        Effect.forkScoped,
      )

    yield* handle(discord.commands, command)
    yield* handle(discord.autocompletes, autocomplete)

    // Autocomplete must answer within 3 seconds, so load the model lists before anyone types.
    yield* Effect.forEach(fleet.remotes, (remote) => models.catalog(remote, remote.directory).pipe(Effect.ignore), {
      discard: true,
    }).pipe(Effect.forkScoped)

    yield* discord.registerCommands(specs).pipe(
      Effect.tap((guilds) => Effect.logInfo("Registered slash commands", { guilds })),
      Effect.catch((cause) => Effect.logWarning("Could not register slash commands", { cause })),
      Effect.forkScoped,
    )
  }),
)

export * as Commands from "./Commands.ts"
