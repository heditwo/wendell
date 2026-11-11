import { DiscordREST, Discord as DiscordTypes } from "dfx"
import { DiscordGateway } from "dfx/gateway"
import { Effect, Option } from "effect"
import type { GuildId } from "../shared/Ids.ts"
import type { ProfileUpdate } from "./Discord.ts"
import { discordError } from "./DiscordError.ts"
import type { Presence } from "./Presence.ts"

const activityTypes = {
  playing: DiscordTypes.ActivityType.Playing,
  listening: DiscordTypes.ActivityType.Listening,
  watching: DiscordTypes.ActivityType.Watching,
  competing: DiscordTypes.ActivityType.Competing,
  custom: DiscordTypes.ActivityType.Custom,
} as const

const presenceStatuses = {
  online: DiscordTypes.PresenceUpdateStatus.Online,
  idle: DiscordTypes.PresenceUpdateStatus.Idle,
  dnd: DiscordTypes.PresenceUpdateStatus.DoNotDisturb,
  invisible: DiscordTypes.PresenceUpdateStatus.Invisible,
} as const

/** Wendell's own profile: username, images, "About me", nickname and presence. */
export const make = Effect.gen(function* () {
  const rest = yield* DiscordREST
  const gateway = yield* DiscordGateway

  const updateProfile = Effect.fn("Discord.updateProfile")(
    function* (update: ProfileUpdate) {
      const current = yield* rest.getMyUser()

      yield* rest.updateMyUser({ username: current.username, ...update })
    },
    (effect) => discordError("Discord.updateProfile")(effect),
  )

  const updateAbout = Effect.fn("Discord.updateAbout")(
    function* (text: string | null) {
      yield* rest.updateMyApplication({ description: text === null ? null : { default: text } })
    },
    (effect) => discordError("Discord.updateAbout")(effect),
  )

  const updateNickname = Effect.fn("Discord.updateNickname")(
    function* (guildId: GuildId, nickname: string | null) {
      yield* rest.updateMyGuildMember(guildId, { nick: nickname })
    },
    (effect) => discordError("Discord.updateNickname")(effect),
  )

  const setPresence = Effect.fn("Discord.setPresence")(function* (presence: Presence.Presence) {
    return yield* gateway.send({
      op: DiscordTypes.GatewayOpcodes.PresenceUpdate,
      d: {
        since: null,
        afk: false,
        status: presenceStatuses[presence.status],
        activities: Option.match(presence.activity, {
          onNone: () => [],
          onSome: ({ type, text }) => [
            type === "custom"
              ? { type: activityTypes.custom, name: "Custom Status", state: text }
              : { type: activityTypes[type], name: text },
          ],
        }),
      },
    })
  })

  return { updateProfile, updateAbout, updateNickname, setPresence }
})

export * as Identity from "./Identity.ts"
