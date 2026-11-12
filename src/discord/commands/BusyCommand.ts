import { Effect, Schema } from "effect"
import { BusyModes } from "../../modes/BusyModes.ts"
import { ModeCommand } from "./ModeCommand.ts"

const meaning: Record<BusyModes.Mode, string> = {
  interrupt: "**interrupt**. I read new messages at my next step. If that takes longer than a few seconds, I stop what I am doing and read yours.",
  steer: "**steer**. I read new messages at my next step, and never stop a step for them.",
  wait: "**wait**. New messages wait until I finish what I am doing.",
}

export const make = Effect.gen(function* () {
  return yield* ModeCommand.make({
    spec: {
      name: "busy",
      description: "Choose what happens when you message Wendell while he works. Without a mode, show the current one.",
      options: [
        {
          name: "mode",
          description: "How new messages reach Wendell while he works in this conversation.",
          required: false,
          autocomplete: false,
          choices: [
            { name: "interrupt: he reads it at his next step, and is interrupted if that takes too long", value: "interrupt" },
            { name: "steer: he reads it at his next step, never interrupted", value: "steer" },
            { name: "wait: it waits until he is done", value: "wait" },
          ],
        },
      ],
    },
    setting: yield* BusyModes.Service,
    isMode: Schema.is(BusyModes.Mode),
    noun: "busy mode",
    heading: "While I work here: ",
    describe: (mode) => meaning[mode],
  })
})

export * as BusyCommand from "./BusyCommand.ts"
