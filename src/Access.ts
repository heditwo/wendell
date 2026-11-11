import { Context, Effect, Layer, Match, Option } from "effect"
import { Discord } from "./Discord.ts"
import type { GuildId, UserId } from "./Ids.ts"
import { WendellConfig } from "./WendellConfig.ts"

export interface Member {
  readonly userId: UserId
  readonly guildId: Option.Option<GuildId>
  readonly roles: ReadonlyArray<string>
}

export interface Interface {
  /**
   * Trusted people get full power and can approve tool requests.
   * Everyone else gets Wendell's read-only rules.
   */
  readonly trusted: (member: Member) => Effect.Effect<boolean>
  /** Everyone in this server (or, without one, everyone who can DM Wendell) is trusted. */
  readonly everyoneTrusted: (guildId: Option.Option<GuildId>) => boolean
}

export class Service extends Context.Service<Service, Interface>()("wendell/Access") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* WendellConfig.Service
    const discord = yield* Discord.Service

    const isAdministrator = (guildId: GuildId, member: Member) =>
      discord.guild(guildId).pipe(
        Effect.map(
          (guild) => guild.ownerId === member.userId || member.roles.some((role) => guild.administratorRoles.has(role)),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Could not read server roles, treating the member as untrusted", { guildId, cause }).pipe(
            Effect.as(false),
          ),
        ),
      )

    const trusted = Effect.fn("Access.trusted")(function* (member: Member) {
      if (config.owners.includes(member.userId)) return true

      if (Option.isNone(member.guildId)) return config.defaultAccess === "everyone"

      const guildId = member.guildId.value

      return yield* Match.value(config.accessFor(guildId)).pipe(
        Match.when("everyone", () => Effect.succeed(true)),
        Match.when("administrators", () => isAdministrator(guildId, member)),
        Match.orElse(({ role }) => Effect.succeed(member.roles.includes(role))),
      )
    })

    const everyoneTrusted = (guildId: Option.Option<GuildId>) =>
      Option.match(guildId, {
        onNone: () => config.defaultAccess === "everyone",
        onSome: (id) => config.accessFor(id) === "everyone",
      })

    return Service.of({ trusted, everyoneTrusted })
  }),
)

export * as Access from "./Access.ts"
