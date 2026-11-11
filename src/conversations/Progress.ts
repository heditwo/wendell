import { Option, Schema } from "effect"
import { Policy } from "../opencode/Policy.ts"

const labels: ReadonlyArray<readonly [RegExp, string]> = [
  [/^shell$/, "Running a command"],
  [/^(edit|write|patch)$/, "Editing files"],
  [/^(read|glob|grep)$/, "Reading files"],
  [/^websearch$/, "Searching the web"],
  [/^webfetch$/, "Reading a web page"],
  [/^skill$/, "Loading a skill"],
  [/^subagent$/, "Asking a helper agent"],
  [/^todo/, "Planning"],
  [/^browse_/, "Using the browser"],
]

/** A short status line for a tool call, or none for Wendell's own Discord tools. */
export const label = (tool: string): Option.Option<string> => {
  // `execute` is the Code Mode wrapper; the tools it calls are what matter.
  if (tool === "execute" || tool.startsWith(`${Policy.CLIENT_NAME}_`)) return Option.none()

  const match = labels.find(([pattern]) => pattern.test(tool))

  return Option.some(match?.[1] ?? `Using ${tool.replaceAll("_", " ")}`)
}

/** The Code Mode wrapper: which tools it calls shows only in its streamed code. */
export const isCodeMode = (tool: string) => tool === "execute"

/** A lone reaction is a full answer, so it shows no typing. */
export const isReaction = (tool: string) => tool === `${Policy.CLIENT_NAME}_react`

const toolCall = /tools\.((?:[\w$]+\.)*[\w$]+)\s*\(|tools\.([\w$]+)\[\s*["']([^"']+)["']\s*\]\s*\(/g

export const CodeModeInput = Schema.Struct({ code: Schema.optional(Schema.String) })

export interface CodeModeInput extends Schema.Schema.Type<typeof CodeModeInput> {}

/** Parses the input of an `execute` call; no code when it does not match. */
export const decodeCodeModeInput = Schema.decodeUnknownOption(CodeModeInput)

/** Code Mode code that calls Wendell's reaction tool. */
export const callsReaction = (code: string) => /tools\.wendell\.react\s*\(|tools\.wendell\[\s*["']react["']\s*\]/.test(code)

/** The first tool that streamed Code Mode code calls, other than a reaction, as `namespace_tool`. */
export const calledTool = (code: string): Option.Option<string> => {
  for (const match of code.matchAll(toolCall)) {
    const name = match[1] === undefined ? `${match[2]}_${match[3]}` : match[1].replaceAll(".", "_")

    if (!isReaction(name)) return Option.some(name)
  }

  return Option.none()
}

export * as Progress from "./Progress.ts"
