import { Effect, Option } from "effect"
import { Discord } from "../../discord/Discord.ts"
import { Memory } from "../../memory/Memory.ts"
import type { ChannelId } from "../../shared/Ids.ts"
import { ToolCalls } from "../ToolCalls.ts"

/** `wendell_remember` and `wendell_forget`. */
export const make = Effect.gen(function* () {
  const discord = yield* Discord.Service
  const memory = yield* Memory.Service

  const placeOf = Effect.fn("MemoryTools.placeOf")(function* (channelId: ChannelId) {
    const info = yield* discord.channel(channelId).pipe(Effect.mapError(ToolCalls.failure("Could not read this channel.")))

    return { guildId: info.guildId, channelId } satisfies Memory.Place
  })

  const remember = Effect.fn("MemoryTools.remember")(function* (
    { channelId }: ToolCalls.Target,
    input: ToolCalls.CallOf<"Remember">,
  ) {
    const place = yield* placeOf(channelId)

    const scope: Memory.Scope = yield* input.about === "person"
      ? Option.match(input.userId, {
          onNone: () => ToolCalls.fail("user_id is required for a note about a person."),
          onSome: (userId) => Effect.succeed<Memory.Scope>({ about: "person", userId }),
        })
      : Option.match(place.guildId, {
          onNone: () => ToolCalls.fail("DMs have no server. Use about=person."),
          onSome: (guildId) => Effect.succeed<Memory.Scope>({ about: "server", guildId }),
        })

    const expiresAt = yield* Option.match(input.expires, {
      onNone: () => Effect.succeed(Option.none<number>()),
      onSome: (text) => {
        const time = Date.parse(text)

        return Number.isNaN(time) ? ToolCalls.fail(`expires "${text}" is not a date.`) : Effect.succeed(Option.some(time))
      },
    })

    const note = yield* memory
      .remember({ scope, text: input.text, replaces: input.replaces, expiresAt, messageId: input.messageId }, place)
      .pipe(
        Effect.catchTags({
          "Memory.MemoryFull": (error) => ToolCalls.fail(error.message),
          "Memory.NoteNotFound": (error) => ToolCalls.fail(`No note ${error.id} here to replace.`),
          "JsonStore.StoreError": () => ToolCalls.fail("Could not save your memory."),
        }),
      )

    yield* Effect.logInfo("Remembered a note", { about: input.about, id: note.id, private: note.private })

    return `Saved note ${note.id}${note.private ? " (private to DMs)" : ""}. Do not announce it unless someone asked you to remember it.`
  })

  const forget = Effect.fn("MemoryTools.forget")(function* ({ channelId }: ToolCalls.Target, { id }: ToolCalls.CallOf<"Forget">) {
    const place = yield* placeOf(channelId)
    const scopes = yield* memory.allScopes(place)

    const note = yield* memory.forget(id, scopes, place).pipe(
      Effect.catchTags({
        "Memory.NoteNotFound": () => ToolCalls.fail(`No note ${id} here. Use an ID from the <memory> blocks.`),
        "JsonStore.StoreError": () => ToolCalls.fail("Could not save your memory."),
      }),
    )

    yield* Effect.logInfo("Forgot a note", { id })

    return `Forgot: ${note.text}`
  })

  return { remember, forget }
})

export * as MemoryTools from "./MemoryTools.ts"
