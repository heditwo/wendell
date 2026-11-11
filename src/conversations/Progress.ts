import { Option } from "effect"
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

export * as Progress from "./Progress.ts"
