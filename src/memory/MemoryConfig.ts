import { Schema } from "effect"

/** `memory` in `wendell.json`. */
export const Config = Schema.Struct({
  /**
   * `background` (default): when a conversation has been quiet for a while, a small model reads the new messages and
   * updates the notes. `off`: only explicit "remember that" saves notes.
   */
  capture: Schema.optional(Schema.Literals(["background", "off"])),
  /** The model for background capture, as `provider/model`. Default: the server's `model`. Pick a small, cheap one. */
  captureModel: Schema.optional(Schema.NonEmptyString),
})

export interface Config extends Schema.Schema.Type<typeof Config> {}

export * as MemoryConfig from "./MemoryConfig.ts"
