# Anti-slop source

- Repository: https://github.com/dmmulroy/anti-slop
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7`
- Source: `skills/install-anti-slop/assets/anti-slop/`
- Installed path: `tools/oxlint/anti-slop/`
- Installed with: `skills/install-anti-slop/scripts/install.mjs`

No local rule changes.

`.oxlintrc.json` enables every generic rule and the five Effect rules.
`no-runtime-typeof` uses `allowInTypeGuards: true`.

Run `bun run lint`. Run `bun run lint -- --fix` to apply spacing fixes.
