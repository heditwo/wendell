import { DiscordREST, type Discord as DiscordTypes } from "dfx"
import { Effect } from "effect"
import { truncate } from "../shared/Text.ts"
import type { ButtonPress, Choice, CommandCall, CommandSpec } from "./Discord.ts"
import { discordError } from "./DiscordError.ts"
import { MAX_MESSAGE_LENGTH } from "./Messages.ts"
import { OPTION_STRING } from "./Payloads.ts"

const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5
const RESPONSE_UPDATE_MESSAGE = 7
const RESPONSE_AUTOCOMPLETE = 8
const MAX_CHOICES = 25
const MAX_CHOICE_LENGTH = 100
const FLAG_EPHEMERAL = 64

/** Slash commands, their autocomplete, and button presses. */
export const make = Effect.gen(function* () {
  const rest = yield* DiscordREST

  const registerCommands = Effect.fn("Discord.registerCommands")(
    function* (commands: ReadonlyArray<CommandSpec>) {
      const application = yield* rest.getMyApplication()
      const guilds = yield* rest.listMyGuilds()

      const payload = commands.map((command): DiscordTypes.ApplicationCommandUpdateRequest => ({
        name: command.name,
        description: command.description,
        options: command.options.map((option) => ({
          type: OPTION_STRING,
          name: option.name,
          description: option.description,
          required: option.required,
          autocomplete: option.autocomplete,
          choices: option.choices.length === 0 ? undefined : option.choices,
        })),
      }))

      yield* Effect.forEach(guilds ?? [], (guild) => rest.bulkSetGuildApplicationCommands(application.id, guild.id, payload), {
        discard: true,
      })

      return (guilds ?? []).length
    },
    (effect) => discordError("Discord.registerCommands")(effect),
  )

  const answerAutocomplete = Effect.fn("Discord.answerAutocomplete")(
    function* (call: CommandCall, choices: ReadonlyArray<Choice>) {
      yield* rest.createInteractionResponse(call.interactionId, call.token, {
        payload: {
          type: RESPONSE_AUTOCOMPLETE,
          data: {
            choices: choices.slice(0, MAX_CHOICES).map((choice) => ({
              name: truncate(choice.name, MAX_CHOICE_LENGTH),
              value: choice.value.slice(0, MAX_CHOICE_LENGTH),
            })),
          },
        },
      })
    },
    (effect) => discordError("Discord.answerAutocomplete")(effect),
  )

  const deferCommand = Effect.fn("Discord.deferCommand")(
    function* (call: CommandCall, ephemeral: boolean) {
      yield* rest.createInteractionResponse(call.interactionId, call.token, {
        payload: { type: RESPONSE_DEFERRED_CHANNEL_MESSAGE, data: { flags: ephemeral ? FLAG_EPHEMERAL : undefined } },
      })
    },
    (effect) => discordError("Discord.deferCommand")(effect),
  )

  const editCommandAnswer = Effect.fn("Discord.editCommandAnswer")(
    function* (call: CommandCall, text: string) {
      yield* rest.updateOriginalWebhookMessage(call.applicationId, call.token, {
        payload: { content: truncate(text, MAX_MESSAGE_LENGTH), allowed_mentions: { parse: [] } },
      })
    },
    (effect) => discordError("Discord.editCommandAnswer")(effect),
  )

  const answerPress = Effect.fn("Discord.answerPress")(
    function* (press: ButtonPress, text: string) {
      yield* rest.createInteractionResponse(press.interactionId, press.token, {
        payload: {
          type: RESPONSE_UPDATE_MESSAGE,
          data: { content: truncate(text, MAX_MESSAGE_LENGTH), components: [], allowed_mentions: { parse: [] } },
        },
      })
    },
    (effect) => discordError("Discord.answerPress")(effect),
  )

  return { registerCommands, answerAutocomplete, deferCommand, editCommandAnswer, answerPress }
})

export * as Interactions from "./Interactions.ts"
