import { Cause, Duration, Effect, Layer, Option, Stream } from "effect"
import { Conversations } from "../conversations/Conversations.ts"
import { Source } from "../conversations/Conversation.ts"
import { Discord } from "../discord/Discord.ts"
import { Room } from "../inbound/Room.ts"
import { Routing } from "../inbound/Routing.ts"
import { Screen } from "../inbound/Screen.ts"
import { Recollection } from "../memory/Recollection.ts"
import { BusyModes } from "../modes/BusyModes.ts"
import { Batcher } from "../shared/Batcher.ts"
import type { GuildId } from "../shared/Ids.ts"
import type { Provider } from "../transcription/Provider.ts"
import { SpeechToText } from "../transcription/SpeechToText.ts"
import { Calls } from "./Calls.ts"
import { Speech } from "./Speech.ts"
import { Voice } from "./Voice.ts"

const MAX_BATCH = 20
const GROUP_BUFFER = 16
const IDLE_GUILD = Duration.minutes(30)
const TRANSCRIBE_TIMEOUT = Duration.seconds(30)

// Below this score, a line is skipped when Wendell was not part of the call a moment ago.
const SKIP_BELOW_WHEN_INATTENTIVE = 0.5
const PHANTOM_BELOW_MS = 2000

// Speech recognition writes these for silence and noise, for example "[BLANK_AUDIO]" or "(music)".
const ONLY_NOISE = /^\s*(?:[[(][^\])]*[\])]\s*)+$/

// Speech recognition writes these for silence. A short sound with only these words is not speech.
const PHANTOMS = new Set(["you", "thank you", "thanks", "thanks for watching", "thank you for watching", "bye", "bye bye"])

const isPhantom = (text: string) => PHANTOMS.has(text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))

interface Item extends Speech.Heard {
  /** Someone waits for Wendell: he was addressed, he is alone with the speaker, or the decision model is sure. */
  readonly waits: boolean
  readonly expectsReply: boolean
}

const words = (text: string) => text.split(/\s+/).filter((word) => word !== "").length

/** Transcribes what people say in Wendell's voice calls and delivers it to the conversation that the call belongs to. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const discord = yield* Discord.Service
    const voice = yield* Voice.Service
    const calls = yield* Calls.Service
    const screen = yield* Screen.Service
    const conversations = yield* Conversations.Service
    const recollection = yield* Recollection.Service
    const room = yield* Room.Service
    const busyModes = yield* BusyModes.Service
    const provider = yield* SpeechToText.Service

    if (!voice.enabled) return

    if (Option.isNone(provider)) {
      return yield* Effect.logWarning("Voice is on, but transcription is off, so Wendell does not hear what people say in calls")
    }

    const attempt = (active: Provider.Provider, utterance: Voice.Utterance) =>
      active.transcribe({ name: "utterance.wav", contentType: Option.some("audio/wav"), data: utterance.wav }).pipe(
        Effect.timeout(TRANSCRIBE_TIMEOUT),
        Effect.map((text) => text.trim()),
        Effect.tapError((cause) =>
          Effect.logWarning("Could not transcribe speech in voice", { channelId: utterance.channelId, cause }),
        ),
      )

    // None: the provider failed or did not answer. Some: its text, which is empty for silence.
    // A provider failure is tried once more, because the provider can crash on one utterance and work on the next.
    // A timeout is not, because the utterances of a guild wait for each other. Neither is a call that already fails.
    const transcribe = (active: Provider.Provider, utterance: Voice.Utterance, call: Calls.Call) =>
      attempt(active, utterance).pipe(
        Effect.retry({
          times: 1,
          while: (error) =>
            Cause.isTimeoutError(error) ? Effect.succeed(false) : Effect.map(calls.hearing(call), (state) => !Calls.Hearing.$is("Failing")(state)),
        }),
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none<string>())),
      )

    const hear = Effect.fn("VoiceListener.hear")(function* (utterance: Voice.Utterance) {
      if (utterance.userId === discord.me) return Option.none<Item>()

      const speaker = yield* discord.member(utterance.guildId, utterance.userId)

      if (speaker.isBot) return Option.none<Item>()

      const found = yield* calls.ofChannel(utterance.channelId)

      if (Option.isNone(found)) return Option.none<Item>()

      const call = found.value
      const transcript = yield* transcribe(provider.value, utterance, call)

      yield* calls.transcribed(call, Option.isSome(transcript))

      if (Option.isNone(transcript)) {
        yield* calls.missed(call, speaker.name)

        return Option.none<Item>()
      }

      const text = transcript.value

      if (text === "" || ONLY_NOISE.test(text)) return Option.none<Item>()

      if (utterance.durationMs < PHANTOM_BELOW_MS && isPhantom(text)) return Option.none<Item>()

      yield* Effect.logInfo("Transcribed speech in voice", { channelId: utterance.channelId, words: words(text) })

      const members = yield* calls.people(call)
      const alone = members.length === 1 && members.some((member) => member.userId === utterance.userId)

      const route = Routing.classify({
        fromBot: false,
        addressed: Routing.addressesByName(text),
        named: false,
        spoken: true,
        inTask: false,
        inCall: true,
        alone,
        following: true,
        goal: Option.none(),
      })

      const skipBelow = (yield* calls.attentive(call)) ? undefined : SKIP_BELOW_WHEN_INATTENTIVE

      const verdict = yield* Option.match(Routing.screenQuestion(route), {
        onNone: () => Effect.succeed<Screen.Verdict>({ skip: false, confident: false }),
        onSome: (question) =>
          Effect.gen(function* () {
            const prior = yield* calls.lines(call)

            return yield* screen.screenTranscript(
              call.home.remote,
              call.channelId,
              [...prior, `${speaker.name}: ${text}`].join("\n"),
              question,
              skipBelow,
            )
          }),
      })

      yield* calls.heard(call, { speaker: speaker.name, text, typed: false }, !verdict.skip)

      if (verdict.skip) return Option.none<Item>()

      return Option.some<Item>({
        userId: utterance.userId,
        speaker: speaker.name,
        text,
        durationMs: utterance.durationMs,
        route,
        waits: Routing.expectsReply(route) || verdict.confident,
        expectsReply: Routing.expectsReply(route),
      })
    })

    const deliver = Effect.fn("VoiceListener.deliver")(function* (guildId: GuildId, batch: ReadonlyArray<Item>) {
      if (batch.length === 0) return

      const found = yield* calls.inGuild(guildId)

      if (Option.isNone(found)) return yield* Effect.logDebug("Dropped speech because the call is over", { guildId })

      const call = found.value
      const home = call.home
      const expectsReply = batch.some((item) => item.expectsReply)
      const people = [...new Map(batch.map(({ userId, speaker }) => [userId, speaker] as const))].map(([userId, name]) => ({ userId, name }))

      const recalled = yield* recollection.before({
        conversationKey: `${home.remote.name}/${home.channelId}`,
        remote: home.remote,
        place: { guildId: home.guildId, channelId: home.channelId },
        people,
        text: batch.map(({ speaker, text }) => `${speaker}: ${text}`).join("\n"),
      })

      const overheard = yield* room.take(home)
      const noticed = yield* calls.notice(home)
      const context = yield* calls.takeOverheard(call)
      const interrupted = yield* calls.takeInterrupted(call)

      yield* conversations.deliver(
        home,
        [...recalled.blocks, ...overheard.blocks, ...noticed.blocks, ...context, Speech.renderBatch(batch, interrupted)].join("\n\n"),
        {
          expectReply: expectsReply,
          progress: false,
          lazyProgress: true,
          trigger: Option.none(),
          busy: batch.some((item) => item.waits) ? yield* busyModes.modeFor(home.remote, home.channelId) : "wait",
          source: Source.Speech(),
        },
        overheard.images,
      )
      yield* recalled.delivered
      yield* noticed.delivered
      yield* Effect.logInfo("Delivered speech", { server: home.remote.name, channelId: home.channelId, count: batch.length })
    })

    const perGuild = (guildId: GuildId, utterances: Stream.Stream<Voice.Utterance>) =>
      utterances.pipe(
        Stream.mapEffect((utterance) =>
          hear(utterance).pipe(
            Effect.catch((cause) => Effect.logError("Could not route speech", { guildId, cause }).pipe(Effect.as(Option.none<Item>()))),
          ),
        ),
        Stream.filter(Option.isSome),
        Stream.map((item) => item.value),
        Batcher.batches({ max: MAX_BATCH, windowOf: () => Duration.zero }),
        Stream.mapEffect((batch) =>
          deliver(guildId, batch).pipe(Effect.catch((cause) => Effect.logError("Could not deliver speech", { guildId, cause }))),
        ),
      )

    yield* voice.utterances.pipe(
      Stream.groupByKey((utterance) => utterance.guildId, { bufferSize: GROUP_BUFFER, idleTimeToLive: IDLE_GUILD }),
      Stream.flatMap(([guildId, utterances]) => perGuild(guildId, utterances), { concurrency: "unbounded" }),
      Stream.runDrain,
      Effect.forkScoped,
    )
  }),
)

export * as VoiceListener from "./VoiceListener.ts"
