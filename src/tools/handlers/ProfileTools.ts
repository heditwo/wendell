import { Effect, Option } from "effect"
import { Discord } from "../../discord/Discord.ts"
import { Profile } from "../../discord/Profile.ts"
import { Files } from "../../shared/Files.ts"
import { ToolCalls } from "../ToolCalls.ts"
import { Uploads } from "../Uploads.ts"

const refused = (what: string) => (error: Discord.DiscordError) => {
  const detail = JSON.stringify(error.cause) ?? ""

  return new ToolCalls.ToolFailure({
    message: detail.includes("Ratelimited")
      ? `Discord rate-limited the ${what} change. Username and avatar changes are limited to about 2 per hour. Try later.`
      : `Discord refused the ${what} change: ${detail.slice(0, 300)}`,
  })
}

/** `wendell_set_profile`. Images are read from the server with the same path rules as reply files. */
export const make = Effect.gen(function* () {
  const discord = yield* Discord.Service
  const profile = yield* Profile.Service
  const uploads = yield* Uploads.Service

  /** A data URI for Discord, `null` to remove the image, or `undefined` to keep it. */
  const imageData = Effect.fn("ProfileTools.imageData")(function* (target: ToolCalls.Target, file: string | null | undefined) {
    if (file === undefined || file === null) return file

    const [upload] = yield* uploads
      .load(target.remote, target.channelId, [file])
      .pipe(Effect.mapError((error) => new ToolCalls.ToolFailure({ message: error.message })))

    if (upload === undefined || !Files.isImage(upload.contentType)) {
      return yield* ToolCalls.fail(`${file} is not a PNG, JPEG, GIF or WebP image.`)
    }

    return `data:${upload.contentType};base64,${Buffer.from(upload.data).toString("base64")}`
  })

  const setProfile = Effect.fn("ProfileTools.setProfile")(function* (
    target: ToolCalls.Target,
    { change }: ToolCalls.CallOf<"SetProfile">,
  ) {
    const changed = Object.entries(change).flatMap(([field, value]) => (value === undefined ? [] : [field]))

    if (changed.length === 0) return yield* ToolCalls.fail("Set at least one field to change.")

    if (change.username !== undefined || change.avatar !== undefined || change.banner !== undefined) {
      const avatar = yield* imageData(target, change.avatar)
      const banner = yield* imageData(target, change.banner)

      const update: Discord.ProfileUpdate = {}

      if (change.username !== undefined) update.username = change.username

      if (avatar !== undefined) update.avatar = avatar

      if (banner !== undefined) update.banner = banner

      yield* discord.updateProfile(update).pipe(Effect.mapError(refused("profile")))
    }

    if (change.about !== undefined) yield* discord.updateAbout(change.about).pipe(Effect.mapError(refused("About me")))

    if (change.nickname !== undefined) {
      const info = yield* discord.channel(target.channelId).pipe(Effect.mapError(ToolCalls.failure("Could not read this channel.")))

      if (Option.isNone(info.guildId)) return yield* ToolCalls.fail("Nicknames exist only in Discord servers, not in DMs.")

      yield* discord.updateNickname(info.guildId.value, change.nickname).pipe(Effect.mapError(refused("nickname")))
    }

    if (change.status !== undefined || change.activity !== undefined) {
      const current = yield* profile.presence

      yield* profile
        .setPresence({
          status: change.status ?? current.status,
          activity: change.activity === undefined ? current.activity : Option.fromNullishOr(change.activity),
        })
        .pipe(Effect.mapError(ToolCalls.failure("The presence changed, but Wendell could not save it.")))
    }

    yield* Effect.logInfo("Changed Wendell's profile", { fields: changed })

    return `Changed: ${changed.join(", ")}.`
  })

  return { setProfile }
})

export * as ProfileTools from "./ProfileTools.ts"
