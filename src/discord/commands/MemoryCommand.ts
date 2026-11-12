import { Effect, Option } from "effect"
import { Memory } from "../../memory/Memory.ts"
import type { Discord } from "../Discord.ts"
import { Command } from "./Command.ts"

const describeNote = (note: Memory.Note) =>
  `• ${note.kind === "profile" ? "*how to treat you:* " : ""}${note.text} \`${note.id}\`${note.private ? " (DMs only)" : ""}`

export const make = Effect.gen(function* () {
  const memory = yield* Memory.Service

  // People may see and remove their own notes and this server's notes, never notes about someone else.
  const visible = Effect.fn("MemoryCommand.visible")(function* (call: Discord.CommandCall) {
    const place: Memory.Place = { guildId: call.member.guildId, channelId: call.channelId }

    const scopes: ReadonlyArray<Memory.Scope> = [
      { about: "person", userId: call.member.userId },
      ...Option.toArray(call.member.guildId).map((guildId): Memory.Scope => ({ about: "server", guildId })),
    ]

    const notes = yield* Effect.forEach(scopes, (scope) =>
      memory.recall(scope, place).pipe(Effect.map((found) => ({ scope, notes: found }))),
    )

    return { place, scopes, notes }
  })

  const answer = (call: Discord.CommandCall) =>
    Effect.gen(function* () {
      const { place, scopes, notes } = yield* visible(call)
      const forget = Command.option(call, "forget")

      if (Option.isSome(forget)) {
        const note = yield* memory.forget(forget.value.trim(), scopes, place).pipe(Effect.option)

        return Option.match(note, {
          onNone: () => "I have no note like that about you or this server.",
          onSome: (found) => `Forgotten: ${found.text}`,
        })
      }

      const sections = notes.map(({ scope, notes: found }) =>
        [
          scope.about === "person" ? "**About you**" : "**About this server**",
          ...(found.length === 0 ? ["Nothing yet."] : found.map(describeNote)),
        ].join("\n"),
      )

      return [...sections, "-# Use `/memory forget:` to remove a note."].join("\n\n")
    }).pipe(Command.orReply("Could not answer /memory", "I could not read my memory. Try again."))

  const autocomplete = (call: Discord.CommandCall, query: string) =>
    visible(call).pipe(
      Effect.map(({ notes }) => {
        const wanted = query.toLowerCase()

        return notes
          .flatMap(({ notes: found }) => found)
          .filter((note) => note.text.toLowerCase().includes(wanted) || note.id.includes(wanted))
          .slice(0, Command.MAX_CHOICES)
          .map((note): Discord.Choice => ({ name: note.text.slice(0, 100), value: note.id }))
      }),
    )

  return {
    spec: {
      name: "memory",
      description: "Show what Wendell remembers about you and this server, or make him forget a note.",
      options: [{ name: "forget", description: "The note to forget.", required: false, autocomplete: true, choices: [] }],
    },
    ephemeral: () => true,
    answer,
    autocomplete: Option.some(autocomplete),
  } satisfies Command.Command
})

export * as MemoryCommand from "./MemoryCommand.ts"
