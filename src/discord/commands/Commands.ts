import { Effect, Layer, Option, Stream } from "effect"
import { Discord } from "../Discord.ts"
import { AutoCommand } from "./AutoCommand.ts"
import { BusyCommand } from "./BusyCommand.ts"
import { Command } from "./Command.ts"
import { MemoryCommand } from "./MemoryCommand.ts"
import { ModelCommand } from "./ModelCommand.ts"
import { ModelsCommand } from "./ModelsCommand.ts"
import { RemindersCommand } from "./RemindersCommand.ts"

/** Registers Wendell's slash commands in every server and answers them and their autocomplete requests. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const discord = yield* Discord.Service

    const commands = yield* Effect.all([
      ModelCommand.make,
      ModelsCommand.make,
      AutoCommand.make,
      BusyCommand.make,
      MemoryCommand.make,
      RemindersCommand.make,
    ])

    const byName = new Map(commands.map((command) => [command.spec.name, command]))
    const find = (call: Discord.CommandCall) => Option.fromUndefinedOr(byName.get(call.name))

    const answer = (call: Discord.CommandCall) =>
      Option.match(find(call), {
        onNone: () => Effect.void,
        onSome: (command) =>
          discord.deferCommand(call, command.ephemeral(call)).pipe(
            Effect.andThen(command.answer(call)),
            Effect.flatMap((text) => discord.editCommandAnswer(call, text)),
          ),
      })

    const autocomplete = (call: Discord.CommandCall) =>
      Option.match(Option.flatMap(find(call), (command) => command.autocomplete), {
        onNone: () => Effect.void,
        onSome: (choices) =>
          choices(call, Command.query(call)).pipe(Effect.flatMap((found) => discord.answerAutocomplete(call, found))),
      })

    const handle = (
      stream: Stream.Stream<Discord.CommandCall>,
      run: (call: Discord.CommandCall) => Effect.Effect<void, Discord.DiscordError>,
    ) =>
      stream.pipe(
        Stream.runForEach((call) =>
          run(call).pipe(
            Effect.catch((cause) => Effect.logWarning("Could not answer a slash command", { command: call.name, cause })),
            Effect.forkScoped,
          ),
        ),
        Effect.forkScoped,
      )

    yield* handle(discord.commands, answer)
    yield* handle(discord.autocompletes, autocomplete)

    yield* discord.registerCommands(commands.map((command) => command.spec)).pipe(
      Effect.tap((guilds) => Effect.logInfo("Registered slash commands", { guilds })),
      Effect.catch((cause) => Effect.logWarning("Could not register slash commands", { cause })),
      Effect.forkScoped,
    )
  }),
)

export * as Commands from "./Commands.ts"
