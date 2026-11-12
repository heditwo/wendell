import { Effect, Option } from "effect"
import { Conversations } from "../../conversations/Conversations.ts"
import { Places } from "../../conversations/Places.ts"
import { Discord } from "../../discord/Discord.ts"
import type { ChannelId, GuildId, UserId } from "../../shared/Ids.ts"
import { Voice } from "../../voice/Voice.ts"
import { ToolCalls } from "../ToolCalls.ts"

interface Call {
  readonly guildId: GuildId
  readonly channelId: ChannelId
}

const listChannels = (calls: ReadonlyArray<Call>) => calls.map((call) => `<#${call.channelId}> channel_id=${call.channelId}`).join(", ")

/** `wendell_join_voice` and `wendell_leave_voice`. */
export const make = Effect.gen(function* () {
  const discord = yield* Discord.Service
  const voice = yield* Voice.Service
  const places = yield* Places.Service
  const conversations = yield* Conversations.Service

  // None in a DM.
  const guildOf = Effect.fn("VoiceTools.guildOf")(function* (target: ToolCalls.Target) {
    const info = yield* discord.channel(target.channelId).pipe(Effect.mapError(ToolCalls.failure("Could not read this channel.")))

    return info.guildId
  })

  const voiceChannel = Effect.fn("VoiceTools.voiceChannel")(function* (channelId: ChannelId, here: Option.Option<GuildId>) {
    const info = yield* discord.channel(channelId).pipe(Effect.mapError(ToolCalls.failure("Could not read that channel.")))

    if (!info.isVoice || Option.isNone(info.guildId)) return yield* ToolCalls.fail("That is not a voice channel.")

    if (Option.isSome(here) && !Option.contains(info.guildId, here.value)) {
      return yield* ToolCalls.fail("That is not a voice channel of this Discord server.")
    }

    return { guildId: info.guildId.value, channelId }
  })

  const callOf = Effect.fn("VoiceTools.callOf")(function* (userId: UserId, here: Option.Option<GuildId>) {
    if (Option.isSome(here)) {
      const guildId = here.value
      const channelId = yield* discord.voiceChannelOf(guildId, userId)

      if (Option.isNone(channelId)) return yield* ToolCalls.fail("That person is not in a voice channel of this Discord server.")

      return { guildId, channelId: channelId.value }
    }

    const found = yield* discord.voiceChannelsOf(userId)
    const [only, ...others] = found

    if (only === undefined) return yield* ToolCalls.fail("That person is not in a voice channel of a Discord server that you are in.")

    if (others.length > 0) {
      return yield* ToolCalls.fail(`That person is in more than one voice channel: ${listChannels(found)}. Ask which one, then give channel_id.`)
    }

    return { guildId: only.guildId, channelId: only.channelId }
  })

  const briefCall = Effect.fn("VoiceTools.briefCall")(function* (
    target: ToolCalls.Target,
    call: Call,
    requester: Option.Option<UserId>,
    brief: string,
  ) {
    const authorId = Option.getOrElse(requester, () => discord.me)
    const author = yield* discord.member(call.guildId, authorId).pipe(Effect.orElseSucceed(() => ({ name: "Someone", isBot: false })))
    const place = yield* places.forOrigin({ channelId: call.channelId, guildId: Option.some(call.guildId), authorId, authorName: author.name })

    yield* conversations.deliver(
      place.conversation,
      [
        `${Option.isSome(requester) ? author.name : "Someone"} asked you to join this voice call from another conversation (<#${target.channelId}>).`,
        `What you know from there: ${brief}`,
        "Say hello in a few words.",
      ].join("\n"),
      { expectReply: false, progress: false, trigger: Option.none() },
    )
  })

  const join = Effect.fn("VoiceTools.join")(function* (target: ToolCalls.Target, call: ToolCalls.CallOf<"JoinVoice">) {
    const here = yield* guildOf(target)

    const found = yield* Option.match(call.channelId, {
      onSome: (channelId) => voiceChannel(channelId, here),
      onNone: () =>
        Option.match(call.userId, {
          onNone: () => ToolCalls.fail("Give user_id or channel_id."),
          onSome: (userId) => callOf(userId, here),
        }),
    })

    yield* voice
      .join(found.guildId, found.channelId)
      .pipe(
        Effect.mapError(
          (error) =>
            new ToolCalls.ToolFailure({
              message: `${error.message} Wendell needs the Connect and Speak permissions in that channel.`,
            }),
        ),
      )

    if (found.channelId === target.channelId) {
      return "Joined the voice call of this channel. What people say in the call comes to this conversation, and your replies here are spoken aloud."
    }

    yield* Option.match(call.brief, {
      onNone: () => Effect.void,
      onSome: (brief) =>
        briefCall(target, found, call.userId, brief).pipe(
          Effect.catch((cause) => Effect.logWarning("Could not brief the voice call", { channelId: found.channelId, cause })),
        ),
    })

    return (
      `Joined the voice channel <#${found.channelId}>. The call has its own conversation, in the text chat of <#${found.channelId}>: ` +
      "what people say in the call goes there, and you answer them there, not here. " +
      "Here, say in one short sentence that you joined."
    )
  })

  const leave = Effect.fn("VoiceTools.leave")(function* (target: ToolCalls.Target) {
    const here = yield* guildOf(target)

    if (Option.isSome(here)) {
      return (yield* voice.leave(here.value)) ? "Left the voice channel." : "You are not in a voice channel of this Discord server."
    }

    const calls = yield* voice.calls
    const [only, ...others] = calls

    if (only === undefined) return "You are not in a voice channel."

    if (others.length > 0) {
      return yield* ToolCalls.fail(`You are in more than one voice channel: ${listChannels(calls)}. Ask in the server of the call to leave.`)
    }

    yield* voice.leave(only.guildId)

    return `Left the voice channel <#${only.channelId}>.`
  })

  return { join, leave }
})

export * as VoiceTools from "./VoiceTools.ts"
