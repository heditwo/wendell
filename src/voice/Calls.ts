import { Clock, Context, Data, Deferred, Effect, HashMap, Layer, Option, Ref, Stream } from "effect"
import path from "node:path"
import type { Conversation } from "../conversations/Conversation.ts"
import { Discord } from "../discord/Discord.ts"
import type { ChannelId, GuildId, ServerName } from "../shared/Ids.ts"
import { attribute, escape } from "../shared/Text.ts"
import { SpeechToText } from "../transcription/SpeechToText.ts"
import { Silence } from "./Silence.ts"
import { Voice } from "./Voice.ts"

const CALL_LINES = 12
const ATTENTIVE_FOR = 45_000
const FAILURES_UNTIL_LOST = 2
const WENDELL = "Wendell (agent): "
const LOST = "I cannot hear the call: speech recognition is failing. Type in the chat instead."
const RECOVERED = "I can hear the call again."

/** A voice call that Wendell is connected to. */
export interface Call {
  readonly guildId: GuildId
  /** The voice channel. Its text chat has the same ID. */
  readonly channelId: ChannelId
  /** The conversation that asked Wendell to join. Speech in the call goes to it. */
  readonly home: Conversation
}

export type Hearing = Data.TaggedEnum<{
  /** Nothing was transcribed yet, and the check after the join has not finished. */
  Unchecked: {}
  Working: {}
  /** Speech recognition fails, so Wendell does not get what people say. */
  Failing: {}
  /** Transcription is off in `wendell.json`. */
  Off: {}
}>

export const Hearing = Data.taggedEnum<Hearing>()

/** One thing that a person said in the call, or typed while in it. */
export interface Line {
  readonly speaker: string
  readonly text: string
  readonly typed: boolean
}

/** Same contract as `Recollection.Recall`: run `delivered` only after the prompt was delivered. */
export interface Notice {
  readonly blocks: ReadonlyArray<string>
  readonly delivered: Effect.Effect<void>
}

export interface Interface {
  readonly enabled: boolean
  /** Joins the voice channel, or moves to it, waits until audio can play, and makes `home` the call's conversation. */
  readonly join: (guildId: GuildId, channelId: ChannelId, home: Conversation) => Effect.Effect<Call, Voice.VoiceError>
  /** False when Wendell was not in a voice channel of this guild. */
  readonly leave: (guildId: GuildId) => Effect.Effect<boolean>
  readonly all: Effect.Effect<ReadonlyArray<Call>>
  readonly inGuild: (guildId: GuildId) => Effect.Effect<Option.Option<Call>>
  /** The call in the voice channel with this ID. */
  readonly ofChannel: (channelId: ChannelId) => Effect.Effect<Option.Option<Call>>
  /** The call that belongs to this conversation. */
  readonly ofHome: (server: ServerName, channelId: ChannelId) => Effect.Effect<Option.Option<Call>>
  /** The people in the call's voice channel, without bots. */
  readonly people: (call: Call) => Effect.Effect<ReadonlyArray<Discord.VoiceMember>>
  /**
   * Speaks the readable part of `text` in the call. `from` is the conversation that said it, when it is not the
   * call's home. False when nothing is readable or the connection is gone.
   */
  readonly say: (call: Call, text: string, from: Option.Option<ChannelId>) => Effect.Effect<boolean>
  /**
   * Records a line of the call. `forWendell` false: the agent did not get it, so it stays for `takeOverheard`.
   */
  readonly heard: (call: Call, line: Line, forWendell: boolean) => Effect.Effect<void>
  /** Records that speech recognition could not transcribe what `speaker` said. The agent learns it with `takeOverheard`. */
  readonly missed: (call: Call, speaker: string) => Effect.Effect<void>
  /** The last lines of the call, by people and by Wendell, as "name: text", for the decision model. */
  readonly lines: (call: Call) => Effect.Effect<ReadonlyArray<string>>
  /** The lines since the last call that the agent did not get, as a `<call_context>` block. Empty when there are none. */
  readonly takeOverheard: (call: Call) => Effect.Effect<ReadonlyArray<string>>
  /** Wendell spoke in the call a short time ago, so the next lines can be answers to him. */
  readonly attentive: (call: Call) => Effect.Effect<boolean>
  readonly hearing: (call: Call) => Effect.Effect<Hearing>
  /**
   * Records the result of one transcription. After two failures in a row, Wendell tells the people in the call
   * that he cannot hear them, in the call and in the call's conversation. He posts again when it works again.
   */
  readonly transcribed: (call: Call, ok: boolean) => Effect.Effect<void>
  /** Transcribes a short silent sound to learn if speech recognition works. A failure is told to the call, like `transcribed`. */
  readonly checkHearing: (call: Call) => Effect.Effect<Hearing>
  /** True one time after a person spoke over Wendell and his speech stopped. */
  readonly takeInterrupted: (call: Call) => Effect.Effect<boolean>
  /** What a conversation must know about Wendell's calls, as `<call>` blocks in front of its next batch. */
  readonly notice: (conversation: Conversation) => Effect.Effect<Notice>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Calls") {}

interface State {
  readonly home: Conversation
  readonly lines: ReadonlyArray<string>
  /** Escaped, because they go in a prompt. */
  readonly overheard: ReadonlyArray<string>
  readonly attentiveAt: Option.Option<number>
  readonly hearing: Hearing
  readonly failures: number
  /** The people in the call were told that Wendell cannot hear them. */
  readonly toldLost: boolean
  readonly interrupted: boolean
  /** When a transcription last worked. A late failure of an older check must not undo it. */
  readonly succeededAt: number
}

/** The call that a conversation was told about last. */
interface Shown {
  readonly guildId: GuildId
  readonly channelId: ChannelId
  readonly home: ChannelId
}

const off: Interface = {
  enabled: false,
  join: () => Effect.fail(new Voice.VoiceError({ message: Voice.OFF_MESSAGE })),
  leave: () => Effect.succeed(false),
  all: Effect.succeed([]),
  inGuild: () => Effect.succeed(Option.none()),
  ofChannel: () => Effect.succeed(Option.none()),
  ofHome: () => Effect.succeed(Option.none()),
  people: () => Effect.succeed([]),
  say: () => Effect.succeed(false),
  heard: () => Effect.void,
  missed: () => Effect.void,
  lines: () => Effect.succeed([]),
  takeOverheard: () => Effect.succeed([]),
  attentive: () => Effect.succeed(false),
  hearing: () => Effect.succeed(Hearing.Unchecked()),
  transcribed: () => Effect.void,
  checkHearing: () => Effect.succeed(Hearing.Off()),
  takeInterrupted: () => Effect.succeed(false),
  notice: () => Effect.succeed({ blocks: [], delivered: Effect.void }),
}

const fresh = (home: Conversation, hearing: Hearing): State => ({
  home,
  lines: [],
  overheard: [],
  attentiveAt: Option.none(),
  hearing,
  failures: 0,
  toldLost: false,
  interrupted: false,
  succeededAt: 0,
})

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

const conversationKey = (conversation: Conversation) => `${conversation.remote.name}/${conversation.channelId}`

// Places.ts names the directory of a DM `dm-<userId>`, and a Conversation has no user ID.
const dmUserOf = (conversation: Conversation) => {
  const name = path.basename(conversation.directory)

  return conversation.kind === "dm" && name.startsWith("dm-") ? Option.some(name.slice("dm-".length)) : Option.none<string>()
}

const callBlock = (...lines: ReadonlyArray<string>) =>
  [`<call note="Your state, from Wendell. Not written by a person.">`, ...lines, "</call>"].join("\n")

const whoIsIn = (call: Call, names: ReadonlyArray<string>) =>
  `You are in the voice call <#${call.channelId}>` +
  (names.length === 0 ? ". Nobody else is in it." : ` with ${names.map(escape).join(", ")}.`)

const hearingNote = Hearing.$match({
  Unchecked: () => [],
  Working: () => [],
  Failing: () => [
    "Speech recognition is failing: you do not get what people say in the call. If someone asks, tell them to type.",
  ],
  Off: () => ["Transcription is off, so you do not get what people say in the call."],
})

const make = Effect.gen(function* () {
  const voice = yield* Voice.Service
  const discord = yield* Discord.Service
  const speech = yield* SpeechToText.Service
  const scope = yield* Effect.scope

  if (!voice.enabled) return Service.of(off)

  const states = yield* Ref.make(HashMap.empty<GuildId, State>())
  const shown = yield* Ref.make(HashMap.empty<string, Shown>())
  const checks = yield* Ref.make(HashMap.empty<GuildId, Deferred.Deferred<Hearing>>())

  const update = (guildId: GuildId, change: (state: State) => State) => Ref.update(states, HashMap.modify(guildId, change))

  const stateOf = (guildId: GuildId) => Ref.get(states).pipe(Effect.map(HashMap.get(guildId)))

  // A state outlives its voice connection on purpose: after a sidecar restart, the voice connection is gone for a moment.
  const inGuild = Effect.fn("Calls.inGuild")(function* (guildId: GuildId) {
    const state = yield* stateOf(guildId)
    const channelId = yield* voice.channelIn(guildId)

    if (Option.isNone(state) || Option.isNone(channelId)) return Option.none<Call>()

    return Option.some<Call>({ guildId, channelId: channelId.value, home: state.value.home })
  })

  const all = Ref.get(states).pipe(
    Effect.flatMap((current) => Effect.forEach(HashMap.keys(current), inGuild)),
    Effect.map((calls) => calls.flatMap(Option.toArray)),
  )

  const ofChannel = (channelId: ChannelId) =>
    all.pipe(Effect.map((calls) => Option.fromUndefinedOr(calls.find((call) => call.channelId === channelId))))

  const ofHome = (server: ServerName, channelId: ChannelId) =>
    all.pipe(
      Effect.map((calls) =>
        Option.fromUndefinedOr(calls.find(({ home }) => home.remote.name === server && home.channelId === channelId)),
      ),
    )

  const people = (call: Call) =>
    discord.voiceMembers(call.channelId).pipe(Effect.map((members) => members.filter((member) => !member.isBot)))

  const join = Effect.fn("Calls.join")(function* (guildId: GuildId, channelId: ChannelId, home: Conversation) {
    const before = yield* voice.channelIn(guildId)

    yield* voice.join(guildId, channelId)

    const hearing = Option.isNone(speech) ? Hearing.Off() : Hearing.Unchecked()

    yield* Ref.update(states, (current) => {
      const next = fresh(home, hearing)

      // The lines can contain what people typed in the old home's channel, so another home does not get them.
      const previous = Option.contains(before, channelId)
        ? Option.filter(HashMap.get(current, guildId), (kept) => conversationKey(kept.home) === conversationKey(home))
        : Option.none()

      return HashMap.set(
        current,
        guildId,
        Option.match(previous, {
          onNone: () => next,
          onSome: (kept) => ({ ...next, lines: kept.lines, overheard: kept.overheard }),
        }),
      )
    })

    const call: Call = { guildId, channelId, home }

    yield* Effect.forkIn(checkHearing(call), scope)

    return call
  })

  const leave = Effect.fn("Calls.leave")(function* (guildId: GuildId) {
    yield* Ref.update(states, HashMap.remove(guildId))

    return yield* voice.leave(guildId)
  })

  const say = Effect.fn("Calls.say")(function* (call: Call, text: string, from: Option.Option<ChannelId>) {
    const spoken = yield* voice.speak(call.guildId, text)

    if (Option.isNone(spoken)) return false

    const now = yield* Clock.currentTimeMillis

    // Wendell can say one reply in several parts. They stay one line, so they do not push out what people said.
    const withSpoken = (all: ReadonlyArray<string>) => {
      const last = all.at(-1)

      return last !== undefined && last.startsWith(WENDELL)
        ? [...all.slice(0, -1), `${last} ${spoken.value}`]
        : [...all, `${WENDELL}${spoken.value}`].slice(-CALL_LINES)
    }

    yield* update(call.guildId, (state) => ({
      ...state,
      lines: withSpoken(state.lines),
      overheard: Option.match(from, {
        onNone: () => state.overheard,
        onSome: (channelId) =>
          [...state.overheard, `Wendell (you, from <#${channelId}>): ${escape(spoken.value)}`].slice(-CALL_LINES),
      }),
      attentiveAt: Option.some(now),
    }))

    return true
  })

  const heard = Effect.fn("Calls.heard")(function* (call: Call, line: Line, forWendell: boolean) {
    const text = `${line.typed ? `${line.speaker} (typed)` : line.speaker}: ${oneLine(line.text)}`

    yield* update(call.guildId, (state) => ({
      ...state,
      lines: [...state.lines, text].slice(-CALL_LINES),
      overheard: forWendell ? state.overheard : [...state.overheard, escape(text)].slice(-CALL_LINES),
    }))
  })

  const missed = Effect.fn("Calls.missed")(function* (call: Call, speaker: string) {
    yield* update(call.guildId, (state) => ({
      ...state,
      overheard: [...state.overheard, `${escape(speaker)} said something that speech recognition could not transcribe.`].slice(-CALL_LINES),
    }))
  })

  const lines = (call: Call) =>
    stateOf(call.guildId).pipe(Effect.map(Option.match({ onNone: () => [], onSome: (state) => state.lines })))

  const takeOverheard = Effect.fn("Calls.takeOverheard")(function* (call: Call) {
    const taken = yield* Ref.modify(states, (current): readonly [ReadonlyArray<string>, HashMap.HashMap<GuildId, State>] => {
      const state = HashMap.get(current, call.guildId)

      return Option.match(state, {
        onNone: () => [[], current],
        onSome: (found) => [found.overheard, HashMap.set(current, call.guildId, { ...found, overheard: [] })],
      })
    })

    if (taken.length === 0) return []

    return [
      [
        `<call_context note="${attribute(
          "Said or typed in the voice call since your last turn, and not for you, oldest first. Context only; do not answer it.",
        )}">`,
        ...taken,
        "</call_context>",
      ].join("\n"),
    ]
  })

  const attentive = Effect.fn("Calls.attentive")(function* (call: Call) {
    const state = yield* stateOf(call.guildId)
    const now = yield* Clock.currentTimeMillis

    return Option.exists(state, ({ attentiveAt }) => Option.exists(attentiveAt, (at) => now - at <= ATTENTIVE_FOR))
  })

  const hearing = (call: Call) =>
    stateOf(call.guildId).pipe(
      Effect.map(Option.match({ onNone: () => Hearing.Unchecked(), onSome: (state) => state.hearing })),
    )

  const announce = Effect.fn("Calls.announce")(function* (call: Call, text: string, aloud: boolean) {
    yield* discord.send(call.home.channelId, text, Option.none()).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not post about the call", { channelId: call.home.channelId, cause })),
    )

    if (aloud) yield* say(call, text, Option.none())
  })

  type Change = "lost" | "recovered" | "same"

  const change = (call: Call, next: (state: State) => readonly [Change, State]) =>
    Ref.modify(states, (current): readonly [Change, HashMap.HashMap<GuildId, State>] =>
      Option.match(HashMap.get(current, call.guildId), {
        onNone: () => ["same", current],
        onSome: (found) => {
          const [changed, state] = next(found)

          return [changed, HashMap.set(current, call.guildId, state)]
        },
      }),
    ).pipe(
      Effect.flatMap((changed) => {
        if (changed === "lost") return announce(call, LOST, true)

        return changed === "recovered" ? announce(call, RECOVERED, false) : Effect.void
      }),
    )

  const worked = (state: State, at: number): readonly [Change, State] => [
    state.toldLost ? "recovered" : "same",
    { ...state, hearing: Hearing.Working(), failures: 0, toldLost: false, succeededAt: at },
  ]

  const lost = (state: State, failures: number): readonly [Change, State] =>
    state.toldLost
      ? ["same", { ...state, failures, hearing: Hearing.Failing() }]
      : ["lost", { ...state, failures, hearing: Hearing.Failing(), toldLost: true }]

  const transcribed = Effect.fn("Calls.transcribed")(function* (call: Call, ok: boolean) {
    const now = yield* Clock.currentTimeMillis

    yield* change(call, (state) => {
      if (ok) return worked(state, now)

      const failures = state.failures + 1

      return failures >= FAILURES_UNTIL_LOST ? lost(state, failures) : ["same", { ...state, failures }]
    })
  })

  const probe = Effect.fn("Calls.probe")(function* (call: Call) {
    if (Option.isNone(speech)) {
      yield* update(call.guildId, (state) => ({ ...state, hearing: Hearing.Off() }))

      return Hearing.Off()
    }

    const startedAt = yield* Clock.currentTimeMillis

    const ok = yield* Silence.probe(speech.value).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Speech recognition failed on a silent sound", { guildId: call.guildId, cause: Silence.describe(error) }).pipe(
          Effect.as(false),
        ),
      ),
    )

    yield* change(call, (state) => {
      if (ok) return worked(state, startedAt)

      // Speech that was transcribed after the check started is newer evidence than the check.
      return state.succeededAt >= startedAt ? ["same", state] : lost(state, state.failures)
    })

    return yield* hearing(call)
  })

  // The probe runs in the layer's scope, so a caller that stops waiting does not cancel it.
  // A second caller waits for the check that is running, so a join does not transcribe twice.
  const checkHearing = Effect.fn("Calls.checkHearing")(function* (call: Call) {
    const pending = yield* Deferred.make<Hearing>()

    const awaited = yield* Effect.uninterruptibleMask((restore) =>
      Ref.modify(checks, (current) => {
        const found = HashMap.get(current, call.guildId)

        return [found, Option.isSome(found) ? current : HashMap.set(current, call.guildId, pending)] as const
      }).pipe(
        Effect.flatMap((running) =>
          Option.match(running, {
            onSome: (check) => Effect.succeed(check),
            onNone: () =>
              restore(probe(call)).pipe(
                Effect.onExit((exit) =>
                  Deferred.done(pending, exit).pipe(Effect.andThen(Ref.update(checks, HashMap.remove(call.guildId)))),
                ),
                Effect.forkIn(scope),
                Effect.as(pending),
              ),
          }),
        ),
      ),
    )

    return yield* Deferred.await(awaited)
  })

  const takeInterrupted = (call: Call) =>
    Ref.modify(states, (current): readonly [boolean, HashMap.HashMap<GuildId, State>] => {
      const state = HashMap.get(current, call.guildId)

      return Option.match(state, {
        onNone: () => [false, current],
        onSome: (found) => [found.interrupted, found.interrupted ? HashMap.set(current, call.guildId, { ...found, interrupted: false }) : current],
      })
    })

  const remember = (key: string, call: Call) =>
    Ref.update(shown, HashMap.set(key, { guildId: call.guildId, channelId: call.channelId, home: call.home.channelId }))

  const forget = (key: string) => Ref.update(shown, HashMap.remove(key))

  const homeNotice = Effect.fn("Calls.homeNotice")(function* (key: string, call: Call) {
    const names = (yield* people(call)).map((member) => member.name)
    const state = yield* hearing(call)

    const text = callBlock(
      `${whoIsIn(call, names)} The call belongs to this conversation: what people say in it comes here as <speech>.`,
      "When you answer speech, or a message from a person who is in the call, your wendell_reply is spoken in the call and not posted as text. " +
        "When a person asks for the text, set post: true. To speak another reply, set speak: true. To post without speech, set speak: false.",
      "For the call, write one to three short, plain sentences, without markdown or lists. " +
        "Code, links and files are not spoken. A reply that has them is also posted, so say that they are in the chat.",
      ...hearingNote(state),
    )

    return { blocks: [text], delivered: remember(key, call) }
  })

  const callOfConversation = Effect.fn("Calls.callOfConversation")(function* (conversation: Conversation) {
    if (Option.isSome(conversation.guildId)) return yield* inGuild(conversation.guildId.value)

    const userId = dmUserOf(conversation)

    if (Option.isNone(userId)) return Option.none<Call>()

    for (const call of yield* all) {
      const members = yield* discord.voiceMembers(call.channelId)

      if (members.some((member) => member.userId === userId.value && !member.isBot)) return Option.some(call)
    }

    return Option.none<Call>()
  })

  const notice = Effect.fn("Calls.notice")(function* (conversation: Conversation) {
    const key = conversationKey(conversation)
    const home = yield* ofHome(conversation.remote.name, conversation.channelId)

    if (Option.isSome(home)) return yield* homeNotice(key, home.value)

    const call = yield* callOfConversation(conversation)
    const previous = HashMap.get(yield* Ref.get(shown), key)

    if (Option.isSome(call)) {
      const names = (yield* people(call.value)).map((member) => member.name)

      const text = callBlock(
        `${whoIsIn(call.value, names)} The call belongs to your conversation in <#${call.value.home.channelId}>: speech goes there, not here. ` +
          "To say something in the call from here, call wendell_reply with speak: true. " +
          "When people want to talk with you in the call from this conversation, call wendell_join_voice here: the call then belongs to this conversation.",
      )

      // Told one time for each call, not again when a person joins or leaves it.
      const told = Option.exists(previous, (last) => last.channelId === call.value.channelId && last.home === call.value.home.channelId)

      return told ? { blocks: [], delivered: Effect.void } : { blocks: [text], delivered: remember(key, call.value) }
    }

    if (Option.isNone(previous)) return { blocks: [], delivered: Effect.void }

    const stillThere = yield* inGuild(previous.value.guildId)

    if (Option.isSome(stillThere)) {
      yield* forget(key)

      return { blocks: [], delivered: Effect.void }
    }

    return { blocks: [callBlock(`You left the voice call <#${previous.value.channelId}>.`)], delivered: forget(key) }
  })

  yield* voice.interruptions.pipe(
    Stream.runForEach((guildId) => update(guildId, (state) => ({ ...state, interrupted: true }))),
    Effect.forkScoped,
  )

  return Service.of({
    enabled: true,
    join,
    leave,
    all,
    inGuild,
    ofChannel,
    ofHome,
    people,
    say,
    heard,
    missed,
    lines,
    takeOverheard,
    attentive,
    hearing,
    transcribed,
    checkHearing,
    takeInterrupted,
    notice,
  })
})

export const layer = Layer.effect(Service, make)

export * as Calls from "./Calls.ts"
