import { Effect, Schema } from "effect"
import { ApprovalModes } from "../../modes/ApprovalModes.ts"
import { ModeCommand } from "./ModeCommand.ts"

const meaning: Record<ApprovalModes.Mode, string> = {
  off: "I post approval buttons for every request.",
  review: "I approve requests that clearly fit what you asked for, and post buttons for the rest.",
  auto: "I approve every request without asking.",
}

/** `/auto`: how Wendell answers permission requests in this conversation. Only people may change it. */
export const make = Effect.gen(function* () {
  return yield* ModeCommand.make({
    spec: {
      name: "auto",
      description: "Choose how Wendell handles permission requests here. Without a mode, show the current one.",
      options: [
        {
          name: "mode",
          description: "How Wendell answers permission requests in this conversation.",
          required: false,
          autocomplete: false,
          choices: [
            { name: "review: approve what clearly fits the request, ask about the rest", value: "review" },
            { name: "auto: approve everything", value: "auto" },
            { name: "off: always ask", value: "off" },
          ],
        },
      ],
    },
    setting: yield* ApprovalModes.Service,
    isMode: Schema.is(ApprovalModes.Mode),
    noun: "approval mode",
    heading: "Approvals in this conversation: ",
    describe: (mode) => `**${mode}**. ${meaning[mode]} Reading \`.env\` files always needs a person.`,
  })
})

export * as AutoCommand from "./AutoCommand.ts"
