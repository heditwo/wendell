import { Effect, Option } from "effect"
import { Discord } from "../../discord/Discord.ts"
import { Voice } from "../../voice/Voice.ts"
import { ToolCalls } from "../ToolCalls.ts"

/** `wendell_join_voice` and `wendell_leave_voice`. */
export const make = Effect.gen(function* () {
  const discord = yield* Discord.Service
  const voice = yield* Voice.Service

  const guildOf = Effect.fn("VoiceTools.guildOf")(function* (target: ToolCalls.Target) {
    const info = yield* discord.channel(target.channelId).pipe(Effect.mapError(ToolCalls.failure("Could not read this channel.")))

    if (Option.isNone(info.guildId)) {
      return yield* ToolCalls.fail("Voice calls are available only in Discord servers. Discord bots cannot join DM calls.")
    }

    return info.guildId.value
  })

  const join = Effect.fn("VoiceTools.join")(function* (target: ToolCalls.Target, call: ToolCalls.CallOf<"JoinVoice">) {
    const guildId = yield* guildOf(target)

    const channelId = yield* Option.match(call.channelId, {
      onSome: (channelId) =>
        discord.channel(channelId).pipe(
          Effect.mapError(ToolCalls.failure("Could not read that channel.")),
          Effect.flatMap((info) =>
            info.isVoice && Option.contains(info.guildId, guildId)
              ? Effect.succeed(channelId)
              : ToolCalls.fail("That is not a voice channel of this Discord server."),
          ),
        ),
      onNone: () =>
        Option.match(call.userId, {
          onNone: () => ToolCalls.fail("Give user_id or channel_id."),
          onSome: (userId) =>
            discord.voiceChannelOf(guildId, userId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => ToolCalls.fail("That person is not in a voice channel of this Discord server."),
                  onSome: Effect.succeed,
                }),
              ),
            ),
        }),
    })

    yield* voice
      .join(guildId, channelId)
      .pipe(
        Effect.mapError(
          (error) =>
            new ToolCalls.ToolFailure({
              message: `${error.message} Wendell needs the Connect and Speak permissions in that channel.`,
            }),
        ),
      )

    if (channelId === target.channelId) {
      return "Joined the voice call of this channel. What people say in the call comes to this conversation, and your replies here are spoken aloud."
    }

    return (
      `Joined the voice channel <#${channelId}>. The call has its own conversation, in the text chat of <#${channelId}>: ` +
      "what people say in the call goes there, and you answer them there, not here. " +
      "Here, say in one short sentence that you joined."
    )
  })

  const leave = Effect.fn("VoiceTools.leave")(function* (target: ToolCalls.Target) {
    const guildId = yield* guildOf(target)

    return (yield* voice.leave(guildId)) ? "Left the voice channel." : "You are not in a voice channel of this Discord server."
  })

  return { join, leave }
})

export * as VoiceTools from "./VoiceTools.ts"
