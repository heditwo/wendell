import { Clock, Context, Data, Deferred, Duration, Effect, HashMap, Layer, Option, Queue, Ref, Schedule, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { randomUUID } from "node:crypto"
import { WendellConfig } from "../config/WendellConfig.ts"
import { Discord } from "../discord/Discord.ts"
import type { ChannelId, GuildId, UserId } from "../shared/Ids.ts"
import { Protocol } from "./Protocol.ts"
import { Speech } from "./Speech.ts"
import type { VoiceConfig } from "./VoiceConfig.ts"

const JOIN_TIMEOUT = Duration.seconds(20)
const LEAVE_WHEN_ALONE_AFTER = Duration.seconds(30)
const ALONE_CHECK_EVERY = Duration.seconds(5)
const RESTART_FIRST = Duration.seconds(1)
const RESTART_MAX = Duration.minutes(1)

// A run this long counts as healthy, so the next crash restarts quickly again.
const STABLE_RUN = Duration.minutes(1)
const STOP_GRACE = Duration.seconds(5)
const UTTERANCE_BUFFER = 64
const CALL_LINES = 12

/** One complete thing that one person said in a voice channel where Wendell is. */
export interface Utterance {
  readonly guildId: GuildId
  readonly channelId: ChannelId
  readonly userId: UserId
  /** 16 kHz, mono, 16-bit WAV. */
  readonly wav: Uint8Array<ArrayBuffer>
  readonly durationMs: number
}

export class VoiceError extends Schema.TaggedError<VoiceError>()("Voice.VoiceError", {
  message: Schema.String,
}) {}

type Connection = Data.TaggedEnum<{
  Joining: { readonly channelId: ChannelId; readonly ready: Deferred.Deferred<void, VoiceError> }
  Connected: { readonly channelId: ChannelId }
}>

const Connection = Data.taggedEnum<Connection>()

export interface Interface {
  readonly enabled: boolean
  /** Joins the channel, or moves to it, and waits until audio can play. */
  readonly join: (guildId: GuildId, channelId: ChannelId) => Effect.Effect<void, VoiceError>
  /** False when Wendell was not in a voice channel of this guild. */
  readonly leave: (guildId: GuildId) => Effect.Effect<boolean>
  /** The voice channel that Wendell is in or is joining in this guild. */
  readonly channelIn: (guildId: GuildId) => Effect.Effect<Option.Option<ChannelId>>
  /** Wendell is connected to the voice channel with this ID, so what he posts in its chat is also spoken. */
  readonly inCall: (channelId: ChannelId) => Effect.Effect<boolean>
  /** Speaks the readable part of a message in the call of this channel. Does nothing when Wendell is not in it. */
  readonly speak: (channelId: ChannelId, text: string) => Effect.Effect<void>
  readonly utterances: Stream.Stream<Utterance>
  /** Records a transcribed utterance for `callLines`. */
  readonly heard: (channelId: ChannelId, speaker: string, text: string) => Effect.Effect<void>
  /** The last things said in the call, by people and by Wendell, as "name: text" lines. */
  readonly callLines: (channelId: ChannelId) => Effect.Effect<ReadonlyArray<string>>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Voice") {}

const voiceError = (message: string) => new VoiceError({ message })

const off: Interface = {
  enabled: false,
  join: () => Effect.fail(voiceError("Voice is off. The owner can turn it on with the voice setting in wendell.json.")),
  leave: () => Effect.succeed(false),
  channelIn: () => Effect.succeed(Option.none()),
  inCall: () => Effect.succeed(false),
  speak: () => Effect.void,
  utterances: Stream.empty,
  heard: () => Effect.void,
  callLines: () => Effect.succeed([]),
}

const decodeWav = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"))

const make = Effect.fn("Voice.make")(function* (config: VoiceConfig.Resolved) {
  const discord = yield* Discord.Service
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const scope = yield* Effect.scope
  const [program, ...args] = config.sidecar

  const inbox = yield* Ref.make(Option.none<Queue.Queue<string>>())
  const connections = yield* Ref.make(HashMap.empty<GuildId, Connection>())
  const aloneSince = yield* Ref.make(HashMap.empty<GuildId, number>())
  const lastHeard = yield* Ref.make(HashMap.empty<GuildId, number>())
  const lines = yield* Ref.make(HashMap.empty<ChannelId, ReadonlyArray<string>>())
  const utterances = yield* Queue.sliding<Utterance>(UTTERANCE_BUFFER)

  const send = (message: Protocol.Outgoing) =>
    Ref.get(inbox).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.logWarning("The voice sidecar is not running, dropped a message", { type: message.type }),
          onSome: (queue) => Queue.offer(queue, Protocol.encode(message)).pipe(Effect.asVoid),
        }),
      ),
    )

  const connectionOf = (guildId: GuildId) => Ref.get(connections).pipe(Effect.map(HashMap.get(guildId)))

  const forget = Effect.fn("Voice.forget")(function* (guildId: GuildId, reason: string) {
    const previous = yield* Ref.modify(connections, (all) => [HashMap.get(all, guildId), HashMap.remove(all, guildId)])

    yield* Ref.update(aloneSince, HashMap.remove(guildId))

    if (Option.isNone(previous)) return

    yield* Effect.logInfo("Left voice", { guildId, channelId: previous.value.channelId, reason })

    if (Connection.$is("Joining")(previous.value)) {
      yield* Deferred.fail(previous.value.ready, voiceError(`Could not connect to the voice channel: ${reason}.`))
    }
  })

  const leave = Effect.fn("Voice.leave")(function* (guildId: GuildId) {
    const previous = yield* connectionOf(guildId)

    if (Option.isNone(previous)) return false

    yield* forget(guildId, "left")

    if (Option.isSome(yield* Ref.get(inbox))) {
      yield* send({ type: "leave", guildId })
    } else {
      yield* discord.sendVoiceState({ guildId, channelId: Option.none(), selfMute: false, selfDeaf: false })
    }

    return true
  })

  const join = Effect.fn("Voice.join")(function* (guildId: GuildId, channelId: ChannelId) {
    const previous = yield* connectionOf(guildId)

    if (Option.exists(previous, (connection) => Connection.$is("Connected")(connection) && connection.channelId === channelId)) return

    if (Option.isNone(yield* Ref.get(inbox))) return yield* voiceError("The voice sidecar is not running. Try again in a minute.")

    const ready = yield* Deferred.make<void, VoiceError>()

    yield* Option.match(previous, {
      onNone: () => Effect.void,
      onSome: (connection) =>
        Connection.$is("Joining")(connection) ? Deferred.fail(connection.ready, voiceError("Moved to another voice channel.")) : Effect.void,
    })
    yield* Ref.update(connections, (all) => HashMap.set(all, guildId, Connection.Joining({ channelId, ready })))
    yield* send({ type: "join", guildId, channelId, userId: discord.me })

    yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: JOIN_TIMEOUT,
        orElse: () =>
          leave(guildId).pipe(Effect.andThen(Effect.fail(voiceError("Could not connect to the voice channel in time.")))),
      }),
    )
  })

  const channelIn = (guildId: GuildId) =>
    connectionOf(guildId).pipe(Effect.map(Option.map((connection) => connection.channelId)))

  const connectedGuildOf = (channelId: ChannelId) =>
    Ref.get(connections).pipe(
      Effect.map((all) =>
        Option.fromUndefinedOr(
          [...all].find(([, connection]) => Connection.$is("Connected")(connection) && connection.channelId === channelId)?.[0],
        ),
      ),
    )

  const inCall = (channelId: ChannelId) => connectedGuildOf(channelId).pipe(Effect.map(Option.isSome))

  const heard = Effect.fn("Voice.heard")(function* (channelId: ChannelId, speaker: string, text: string) {
    yield* Ref.update(lines, (all) =>
      HashMap.set(all, channelId, [...Option.getOrElse(HashMap.get(all, channelId), () => []), `${speaker}: ${text}`].slice(-CALL_LINES)),
    )
  })

  const callLines = (channelId: ChannelId) =>
    Ref.get(lines).pipe(Effect.map((all) => Option.getOrElse(HashMap.get(all, channelId), () => [])))

  const speak = Effect.fn("Voice.speak")(function* (channelId: ChannelId, text: string) {
    const guildId = yield* connectedGuildOf(channelId)

    if (Option.isNone(guildId)) return

    const names = new Map<string, string>()

    yield* Effect.forEach(
      Speech.mentionedUsers(text),
      (userId) =>
        discord.member(guildId.value, userId).pipe(
          Effect.tap((member) => Effect.sync(() => names.set(userId, member.name))),
          Effect.ignore,
        ),
      { discard: true },
    )

    const spoken = Speech.readable(text, names)

    if (Option.isNone(spoken)) return

    yield* heard(channelId, "Wendell (agent)", spoken.value)
    yield* send({ type: "speak", guildId: guildId.value, id: randomUUID(), text: spoken.value })
  })

  const onMessage = (message: Protocol.Incoming) =>
    Protocol.Incoming.match(message, {
      gateway: ({ guildId, payload }) =>
        Option.match(Protocol.decodeVoiceState(payload), {
          onNone: () => Effect.logWarning("The voice sidecar sent a gateway payload that is not a voice state update", { guildId }),
          onSome: ({ d }) =>
            d.guild_id === guildId
              ? discord.sendVoiceState({
                  guildId,
                  channelId: Option.fromNullishOr(d.channel_id),
                  selfMute: d.self_mute,
                  selfDeaf: d.self_deaf,
                }).pipe(Effect.asVoid)
              : Effect.logWarning("The voice sidecar sent a voice state update for another guild", { guildId }),
        }),
      ready: ({ guildId, channelId }) =>
        Effect.gen(function* () {
          const previous = yield* Ref.modify(connections, (all) => [
            HashMap.get(all, guildId),
            HashMap.has(all, guildId) ? HashMap.set(all, guildId, Connection.Connected({ channelId })) : all,
          ])

          if (Option.isNone(previous)) return yield* send({ type: "leave", guildId })

          yield* Effect.logInfo("Joined voice", { guildId, channelId })

          if (Connection.$is("Joining")(previous.value)) yield* Deferred.succeed(previous.value.ready, undefined)
        }),
      disconnected: ({ guildId, reason }) => forget(guildId, reason),
      utterance: ({ guildId, userId, wav, durationMs }) =>
        Effect.gen(function* () {
          const connection = yield* connectionOf(guildId)

          if (Option.isNone(connection) || !Connection.$is("Connected")(connection.value)) return

          yield* Ref.update(lastHeard, HashMap.set(guildId, yield* Clock.currentTimeMillis))
          yield* Queue.offer(utterances, { guildId, channelId: connection.value.channelId, userId, wav: decodeWav(wav), durationMs })
        }),
      speech: ({ guildId, id, state, error }) =>
        state === "failed"
          ? Effect.logWarning("Could not speak in voice", { guildId, id, error })
          : Effect.logDebug("Speech in voice", { guildId, id, state }),
      log: ({ level, message: text, fields }) => {
        const log = { debug: Effect.logDebug, info: Effect.logInfo, warning: Effect.logWarning, error: Effect.logError }[level]

        return log(`Voice sidecar: ${text}`, fields ?? {})
      },
    })

  const onLine = (line: string) =>
    Option.match(Protocol.decode(line), {
      onNone: () => (line.trim() === "" ? Effect.void : Effect.logWarning("The voice sidecar wrote a line that is not a protocol message")),
      onSome: onMessage,
    })

  // Discord keeps Wendell in the channel when the sidecar crashes, so he joins again.
  const rejoin = (channels: ReadonlyArray<readonly [GuildId, ChannelId]>) =>
    Effect.forEach(
      channels,
      ([guildId, channelId]) =>
        join(guildId, channelId).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not join voice again after a restart", { guildId, channelId, cause }).pipe(
              Effect.andThen(discord.sendVoiceState({ guildId, channelId: Option.none(), selfMute: false, selfDeaf: false })),
            ),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )

  // Joins in progress fail. Connected channels stay, so they are joined again after the restart.
  const stopped = Effect.gen(function* () {
    yield* Ref.set(inbox, Option.none())

    const joining = yield* Ref.modify(connections, (all) => [
      [...HashMap.values(all)].filter(Connection.$is("Joining")),
      HashMap.filter(all, Connection.$is("Connected")),
    ])

    yield* Effect.forEach(joining, (connection) => Deferred.fail(connection.ready, voiceError("The voice sidecar stopped.")), {
      discard: true,
    })
  })

  const runOnce = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<string>()

    yield* Queue.offer(queue, Protocol.encode({ type: "configure", tts: config.tts, vad: config.vad }))

    const handle = yield* spawner.spawn(
      ChildProcess.make(program, args, {
        stdin: Stream.fromQueue(queue).pipe(Stream.encodeText),
        stderr: "inherit",
        forceKillAfter: STOP_GRACE,
      }),
    )

    const previous = [...(yield* Ref.getAndSet(connections, HashMap.empty()))].map(
      ([guildId, connection]) => [guildId, connection.channelId] as const,
    )

    yield* Ref.set(inbox, Option.some(queue))
    yield* Effect.logInfo("Started the voice sidecar", { pid: handle.pid })
    yield* rejoin(previous).pipe(Effect.forkScoped)

    yield* handle.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.runForEach(onLine))

    return yield* handle.exitCode
  }).pipe(Effect.ensuring(stopped), Effect.scoped)

  const failures = yield* Ref.make(0)

  const restartAfterExit = Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis

    const exit = yield* runOnce.pipe(
      Effect.map((code) => ({ code: Option.some(code), cause: Option.none<unknown>() })),
      Effect.catch((cause) => Effect.succeed({ code: Option.none<number>(), cause: Option.some<unknown>(cause) })),
    )

    if ((yield* Clock.currentTimeMillis) - started >= Duration.toMillis(STABLE_RUN)) yield* Ref.set(failures, 0)

    const count = yield* Ref.getAndUpdate(failures, (value) => value + 1)
    const delay = Duration.min(Duration.times(RESTART_FIRST, 2 ** Math.min(count, 10)), RESTART_MAX)

    yield* Effect.logError("The voice sidecar stopped, restarting it", {
      code: Option.getOrUndefined(exit.code),
      cause: Option.getOrUndefined(exit.cause),
      restartIn: Duration.format(delay),
    })
    yield* Effect.sleep(delay)
  })

  const checkAlone = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const heardAt = yield* Ref.get(lastHeard)

    for (const [guildId, connection] of yield* Ref.get(connections)) {
      if (!Connection.$is("Connected")(connection)) continue

      const people = (yield* discord.voiceMembers(connection.channelId)).filter((member) => !member.isBot)
      const recentlyHeard = Option.exists(HashMap.get(heardAt, guildId), (time) => now - time < Duration.toMillis(LEAVE_WHEN_ALONE_AFTER))

      if (people.length > 0 || recentlyHeard) {
        yield* Ref.update(aloneSince, HashMap.remove(guildId))
        continue
      }

      const since = Option.getOrElse(HashMap.get(yield* Ref.get(aloneSince), guildId), () => now)

      yield* Ref.update(aloneSince, HashMap.set(guildId, since))

      if (now - since >= Duration.toMillis(LEAVE_WHEN_ALONE_AFTER)) {
        yield* Effect.logInfo("Leaving voice because nobody else is in the channel", { guildId, channelId: connection.channelId })
        yield* leave(guildId)
      }
    }
  })

  const forwardVoiceStates = discord.voiceStateChanges.pipe(
    Stream.filter((change) => change.userId === discord.me),
    Stream.runForEach((change) =>
      Effect.gen(function* () {
        const connection = yield* connectionOf(change.guildId)

        if (Option.isNone(connection)) return

        yield* send({ type: "voiceStateUpdate", guildId: change.guildId, data: change.data })

        // Someone can move Wendell to another channel, or disconnect him.
        yield* Option.match(change.channelId, {
          onNone: () => forget(change.guildId, "disconnected in Discord"),
          onSome: (channelId) =>
            Connection.$is("Connected")(connection.value) && connection.value.channelId !== channelId
              ? Ref.update(connections, (all) => HashMap.set(all, change.guildId, Connection.Connected({ channelId })))
              : Effect.void,
        })
      }),
    ),
  )

  const forwardVoiceServers = discord.voiceServers.pipe(
    Stream.runForEach((event) =>
      connectionOf(event.guildId).pipe(
        Effect.flatMap((connection) =>
          Option.isSome(connection) ? send({ type: "voiceServerUpdate", guildId: event.guildId, data: event.data }) : Effect.void,
        ),
      ),
    ),
  )

  yield* Effect.forkIn(Effect.forever(restartAfterExit), scope)
  yield* Effect.forkIn(forwardVoiceStates, scope)
  yield* Effect.forkIn(forwardVoiceServers, scope)
  yield* Effect.forkIn(checkAlone.pipe(Effect.repeat(Schedule.spaced(ALONE_CHECK_EVERY))), scope)

  return Service.of({
    enabled: true,
    join,
    leave,
    channelIn,
    inCall,
    speak,
    utterances: Stream.fromQueue(utterances),
    heard,
    callLines,
  })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* WendellConfig.Service

    return yield* Option.match(config.voice, {
      onNone: () => Effect.succeed(Service.of(off)),
      onSome: make,
    })
  }),
)

export * as Voice from "./Voice.ts"
