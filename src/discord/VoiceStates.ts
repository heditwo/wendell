import { DiscordREST, Discord as DiscordTypes } from "dfx"
import { DiscordGateway } from "dfx/gateway"
import { Cache, Duration, Effect, HashMap, Option, Ref, Stream } from "effect"
import { ChannelId, GuildId, UserId } from "../shared/Ids.ts"
import type { Member, VoiceGatewayEvent, VoiceMember, VoiceStateChange } from "./Discord.ts"
import { discordError } from "./DiscordError.ts"

interface MemberData {
  readonly nick?: string | null | undefined
  readonly user: { readonly username: string; readonly global_name?: string | null | undefined; readonly bot?: boolean | undefined }
}

const memberOf = (member: MemberData): Member => ({
  name: member.nick ?? member.user.global_name ?? member.user.username,
  isBot: member.user.bot === true,
})

const keyOf = (guildId: GuildId, userId: UserId) => `${guildId}/${userId}`

/**
 * Who is in which voice channel, from `GUILD_CREATE` and `VOICE_STATE_UPDATE`, and the voice gateway events.
 * Run it before anything else waits, so it listens before the first `GUILD_CREATE`.
 */
export const make = Effect.gen(function* () {
  const rest = yield* DiscordREST
  const gateway = yield* DiscordGateway
  const states = yield* Ref.make(HashMap.empty<string, VoiceMember>())

  const onGuild = (guild: DiscordTypes.GatewayGuildCreateDispatchData) =>
    Ref.update(states, (all) => {
      const guildId = GuildId.make(guild.id)
      const members = new Map((guild.members ?? []).flatMap((member) => (member.user === undefined ? [] : [[member.user.id, member] as const])))
      const others = HashMap.filter(all, (state) => state.guildId !== guildId)

      return (guild.voice_states ?? []).reduce((next, state) => {
        if (state.channel_id === null) return next

        const member = state.member ?? members.get(state.user_id)
        const userId = UserId.make(state.user_id)

        return HashMap.set(next, keyOf(guildId, userId), {
          guildId,
          userId,
          channelId: ChannelId.make(state.channel_id),
          ...(member === undefined ? { name: state.user_id, isBot: false } : memberOf(member)),
        })
      }, others)
    })

  const onVoiceState = (state: DiscordTypes.GatewayVoiceStateUpdateDispatchData) => {
    if (state.guild_id === null) return Effect.void

    const guildId = GuildId.make(state.guild_id)
    const userId = UserId.make(state.user_id)

    return Ref.update(states, (all) =>
      state.channel_id === null
        ? HashMap.remove(all, keyOf(guildId, userId))
        : HashMap.set(all, keyOf(guildId, userId), {
            guildId,
            userId,
            channelId: ChannelId.make(state.channel_id),
            ...(state.member === undefined
              ? Option.match(HashMap.get(all, keyOf(guildId, userId)), {
                  onNone: () => ({ name: state.user_id, isBot: false }),
                  onSome: ({ name, isBot }) => ({ name, isBot }),
                })
              : memberOf(state.member)),
          }),
    )
  }

  yield* gateway.fromDispatch("GUILD_CREATE").pipe(Stream.runForEach(onGuild), Effect.forkScoped)
  yield* gateway.fromDispatch("VOICE_STATE_UPDATE").pipe(Stream.runForEach(onVoiceState), Effect.forkScoped)

  const members = yield* Cache.make({
    capacity: 1_000,
    timeToLive: Duration.minutes(30),
    lookup: ({ guildId, userId }: { readonly guildId: GuildId; readonly userId: UserId }) =>
      rest.getGuildMember(guildId, userId).pipe(Effect.map(memberOf), discordError("Discord.member")),
  })

  const member = Effect.fn("Discord.member")(function* (guildId: GuildId, userId: UserId) {
    const known = HashMap.get(yield* Ref.get(states), keyOf(guildId, userId))

    // Without member data, the name is the user ID, so Discord is asked.
    if (Option.isSome(known) && known.value.name !== userId) return { name: known.value.name, isBot: known.value.isBot }

    return yield* Cache.get(members, { guildId, userId })
  })

  // The gateway events can arrive before this module listens, so a miss asks Discord.
  const voiceChannelOf = Effect.fn("Discord.voiceChannelOf")(function* (guildId: GuildId, userId: UserId) {
    const known = HashMap.get(yield* Ref.get(states), keyOf(guildId, userId))

    if (Option.isSome(known)) return Option.some(known.value.channelId)

    return yield* rest.getVoiceState(guildId, userId).pipe(
      Effect.map((state) => Option.fromNullishOr(state.channel_id).pipe(Option.map(ChannelId.make))),
      Effect.orElseSucceed(() => Option.none<ChannelId>()),
    )
  })

  const voiceMembers = Effect.fn("Discord.voiceMembers")(function* (channelId: ChannelId) {
    return [...HashMap.values(yield* Ref.get(states))].filter((state) => state.channelId === channelId)
  })

  const voiceChannelsOf = Effect.fn("Discord.voiceChannelsOf")(function* (userId: UserId) {
    return [...HashMap.values(yield* Ref.get(states))].filter((state) => state.userId === userId)
  })

  const sendVoiceState = Effect.fn("Discord.sendVoiceState")(function* (update: {
    readonly guildId: GuildId
    readonly channelId: Option.Option<ChannelId>
    readonly selfMute: boolean
    readonly selfDeaf: boolean
  }) {
    return yield* gateway.send({
      op: DiscordTypes.GatewayOpcodes.VoiceStateUpdate,
      d: {
        guild_id: update.guildId,
        channel_id: Option.getOrNull(update.channelId),
        self_mute: update.selfMute,
        self_deaf: update.selfDeaf,
      },
    })
  })

  const toChange = (state: DiscordTypes.GatewayVoiceStateUpdateDispatchData): Option.Option<VoiceStateChange> =>
    Option.fromNullishOr(state.guild_id).pipe(
      Option.map((guildId) => ({
        guildId: GuildId.make(guildId),
        userId: UserId.make(state.user_id),
        channelId: Option.fromNullishOr(state.channel_id).pipe(Option.map(ChannelId.make)),
        data: state,
      })),
    )

  const voiceStateChanges: Stream.Stream<VoiceStateChange> = gateway.fromDispatch("VOICE_STATE_UPDATE").pipe(
    Stream.map(toChange),
    Stream.filter(Option.isSome),
    Stream.map((change) => change.value),
  )

  const voiceServers: Stream.Stream<VoiceGatewayEvent> = gateway
    .fromDispatch("VOICE_SERVER_UPDATE")
    .pipe(Stream.map((server) => ({ guildId: GuildId.make(server.guild_id), data: server })))

  return { member, voiceChannelOf, voiceChannelsOf, voiceMembers, sendVoiceState, voiceStateChanges, voiceServers }
})

export * as VoiceStates from "./VoiceStates.ts"
