import type { Permission } from "@opencode/client/effect"

export const CLIENT_NAME = "wendell"

const SECRET_FILE = /(^|[\\/])[^\\/]*\.env(\.[^\\/]*)?$/

/** `.env`, `prod.env`, `.env.local` and the like, anywhere in a path. */
export const isSecretFile = (file: string) => SECRET_FILE.test(file)

const rule = (action: string, resource: string, effect: Permission.Effect): Permission.Rule => ({
  action,
  resource,
  effect,
})

// The shell runs with the host user's full authority, and OpenCode checks only its working
// directory, so every command goes through the conversation's approval mode.
const guards: Permission.Ruleset = [
  rule("shell", "*", "ask"),
  rule("read", "*.env", "ask"),
  rule("read", "*.env.*", "ask"),
  rule("external_directory", "*", "ask"),
  rule("question", "*", "deny"),
]

/**
 * Session rules come after the agent's rules, and the last match wins. The agent's own rules
 * apply (including the owner's denies), plus the guards. An `ask` becomes an approval button.
 */
export const sessionPermissions = (allow: ReadonlyArray<string>): Permission.Ruleset => [
  rule(`${CLIENT_NAME}_*`, "*", "allow"),
  ...allow.map((action) => rule(action, "*", "allow")),
  ...guards,
]

export * as Policy from "./Policy.ts"
