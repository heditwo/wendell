import type { Permission } from "@opencode/client/effect"

export const CLIENT_NAME = "wendell"

/** `trusted` sessions keep the agent's own rules; `guest` sessions are read-only. */
export type Tier = "guest" | "trusted"

const rule = (action: string, resource: string, effect: Permission.Effect): Permission.Rule => ({
  action,
  resource,
  effect,
})

const guards: Permission.Ruleset = [
  rule("read", "*.env", "ask"),
  rule("read", "*.env.*", "ask"),
  rule("external_directory", "*", "ask"),
  rule("question", "*", "deny"),
]

/**
 * Session rules come after the agent's rules, and the last match wins.
 *
 * - `guest`: everything not listed resolves to `ask`, and Wendell rejects every ask.
 * - `trusted`: the agent's own rules apply (including the owner's denies), plus the
 *   guards. An `ask` becomes an approval button that only trusted people can press.
 */
export const sessionPermissions = (tier: Tier, allow: ReadonlyArray<string>): Permission.Ruleset =>
  tier === "trusted"
    ? [rule(`${CLIENT_NAME}_*`, "*", "allow"), ...allow.map((action) => rule(action, "*", "allow")), ...guards]
    : [
        rule("*", "*", "ask"),
        rule("read", "*", "allow"),
        rule("glob", "*", "allow"),
        rule("grep", "*", "allow"),
        rule("webfetch", "*", "allow"),
        rule("websearch", "*", "allow"),
        rule("skill", "*", "allow"),
        rule("execute", "*", "allow"),
        rule("opencode_list_mcp_resources", "*", "allow"),
        rule("opencode_read_mcp_resource", "*", "allow"),
        rule(`${CLIENT_NAME}_*`, "*", "allow"),
        ...allow.map((action) => rule(action, "*", "allow")),
        ...guards,
      ]

export const rejection = (action: string) =>
  `Nobody here can approve "${action}" for this conversation, so it was rejected. ` +
  "Continue without it. If the person needs it, suggest that they ask in a task thread."

export * as Policy from "./Policy.ts"
