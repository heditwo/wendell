import { Duration, Effect, Option } from "effect"
import type { Conversation } from "../../conversations/Conversation.ts"
import { Conversations } from "../../conversations/Conversations.ts"
import { Places } from "../../conversations/Places.ts"
import { Discord } from "../../discord/Discord.ts"
import { SessionKey } from "../../opencode/SessionKey.ts"
import type { ChannelId, GuildId, UserId } from "../../shared/Ids.ts"
import { escape } from "../../shared/Text.ts"
import { Calls } from "../../voice/Calls.ts"
import { ToolCalls } from "../ToolCalls.ts"

const HEARING_WAIT = Duration.seconds(3)

interface Call {
  readonly guildId: GuildId
  readonly channelId: ChannelId
}

const listChannels = (calls: ReadonlyArray<Call>) => calls.map((call) => `<#${call.channelId}> channel_id=${call.channelId}`).join(", ")

/** `wendell_join_voice` and `wendell_leave_voice`. */
export const make = Effect.gen(function* () {
  const discord = yield* Discord.Service
  const calls = yield* Calls.Service
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

  const resolveHome = Effect.fn("VoiceTools.resolveHome")(function* (
    target: ToolCalls.Target,
    here: Option.Option<GuildId>,
    voiceChannel: Call,
    requester: Option.Option<UserId>,
  ) {
    if (Option.isSome(here)) {
      const known = yield* conversations.forSession(target.remote.name, SessionKey.forChannel(target.channelId))

      if (Option.isSome(known)) return known.value
    }

    const authorId = Option.getOrElse(requester, () => discord.me)
    const author = yield* discord.member(voiceChannel.guildId, authorId).pipe(Effect.orElseSucceed(() => ({ name: "Someone", isBot: false })))

    // A server conversation is the home of its own call. A DM is private, so its call belongs to the chat of the voice channel.
    const place = yield* places
      .forOrigin({
        channelId: Option.isSome(here) ? target.channelId : voiceChannel.channelId,
        guildId: Option.some(voiceChannel.guildId),
        authorId,
        authorName: author.name,
      })
      .pipe(Effect.mapError(ToolCalls.failure("Could not start the conversation of the call.")))

    return place.conversation
  })

  const briefCall = Effect.fn("VoiceTools.briefCall")(function* (
    target: ToolCalls.Target,
    home: Conversation,
    requester: Option.Option<UserId>,
    brief: string,
  ) {
    const noticed = yield* calls.notice(home)

    yield* conversations.deliver(
      home,
      [
        ...noticed.blocks,
        `${Option.isSome(requester) ? "A person" : "Someone"} asked you to join this voice call from another conversation (<#${target.channelId}>).`,
        `What you know from there: ${brief}`,
        "Say hello in a few words with wendell_reply and speak: true.",
      ].join("\n"),
      { expectReply: false, progress: false, trigger: Option.none() },
    )
    yield* noticed.delivered
  })

  const hearingWarning = Calls.Hearing.$match({
    Unchecked: () => "",
    Working: () => "",
    Failing: () => " Speech recognition is failing, so you cannot hear the call. The people in the call were told to type. Do not tell them again.",
    Off: () => " Transcription is off, so you cannot hear the call. Say that, and that people can type.",
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

    // Before the join: while a call is live, the voice channel's chat resolves to the call's home.
    const home = yield* resolveHome(target, here, found, call.userId)

    const joined = yield* calls.join(found.guildId, found.channelId, home).pipe(
      Effect.mapError(
        (error) =>
          new ToolCalls.ToolFailure({
            message: `${error.message} Wendell needs the Connect and Speak permissions in that channel.`,
          }),
      ),
    )

    const hearing = yield* calls.checkHearing(joined).pipe(
      Effect.timeoutOrElse({ duration: HEARING_WAIT, orElse: () => calls.hearing(joined) }),
    )

    if (Option.isSome(here)) {
      const names = (yield* calls.people(joined)).map((member) => escape(member.name))

      return (
        `Joined the voice call <#${found.channelId}>${names.length > 0 ? ` with ${names.join(", ")}` : ""}. ` +
        "The call now belongs to this conversation: what people say there comes here, and your replies to it are spoken. " +
        "Say hello in a few words with wendell_reply and speak: true." +
        hearingWarning(hearing)
      )
    }

    yield* Option.match(call.brief, {
      onNone: () => Effect.void,
      onSome: (brief) =>
        briefCall(target, home, call.userId, brief).pipe(
          Effect.catch((cause) => Effect.logWarning("Could not brief the voice call", { channelId: found.channelId, cause })),
        ),
    })

    return (
      `Joined the voice channel <#${found.channelId}>. The call has its own conversation, in <#${home.channelId}>: ` +
      "what people say in the call goes there, and you answer them there, not here. " +
      "Here, say in one short sentence that you joined." +
      hearingWarning(hearing)
    )
  })

  const leave = Effect.fn("VoiceTools.leave")(function* (target: ToolCalls.Target) {
    const here = yield* guildOf(target)

    if (Option.isSome(here)) {
      return (yield* calls.leave(here.value)) ? "Left the voice channel." : "You are not in a voice channel of this Discord server."
    }

    const active = yield* calls.all
    const [only, ...others] = active

    if (only === undefined) return "You are not in a voice channel."

    if (others.length > 0) {
      return yield* ToolCalls.fail(`You are in more than one voice channel: ${listChannels(active)}. Ask in the server of the call to leave.`)
    }

    yield* calls.leave(only.guildId)

    return `Left the voice channel <#${only.channelId}>.`
  })

  return { join, leave }
})

export * as VoiceTools from "./VoiceTools.ts"
