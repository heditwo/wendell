import { Effect, Option } from "effect"
import { Places } from "../../conversations/Places.ts"
import type { ConversationSetting } from "../../modes/ConversationSetting.ts"
import type { Discord } from "../Discord.ts"
import { Command } from "./Command.ts"

export interface Options<Mode extends string> {
  readonly spec: Discord.CommandSpec
  readonly setting: ConversationSetting.Interface<Mode>
  readonly isMode: (value: string) => value is Mode
  /** "approval mode", for the failure messages. */
  readonly noun: string
  /** The answer's first words, for example "While I work here: ". */
  readonly heading: string
  readonly describe: (mode: Mode) => string
}

/** A command with an optional `mode` option: without it, shows the conversation's mode, with it, sets the mode. */
export const make = <Mode extends string>(options: Options<Mode>) =>
  Effect.gen(function* () {
    const places = yield* Places.Service

    const requested = (call: Discord.CommandCall) => Option.filter(Command.option(call, "mode"), options.isMode)

    const answer = (call: Discord.CommandCall) =>
      Effect.gen(function* () {
        const place = yield* places.forOrigin(Command.origin(call))
        const { remote, channelId } = place.conversation
        const mode = requested(call)

        if (Option.isNone(mode)) return `${options.heading}${options.describe(yield* options.setting.modeFor(remote, channelId))}`

        yield* options.setting.set(channelId, mode.value)

        return `${options.heading}${options.describe(mode.value)}`
      }).pipe(Command.orReply(`Could not change the ${options.noun}`, `I could not change the ${options.noun}. Try again.`))

    return {
      spec: options.spec,
      ephemeral: (call) => Option.isNone(requested(call)),
      answer,
      autocomplete: Option.none(),
    } satisfies Command.Command
  })

export * as ModeCommand from "./ModeCommand.ts"
