import { Duration, Effect, Layer, Option, Stream } from "effect"
import { Conversations } from "../conversations/Conversations.ts"
import { Places } from "../conversations/Places.ts"
import { Discord } from "../discord/Discord.ts"
import { Routing } from "../inbound/Routing.ts"
import { Screen } from "../inbound/Screen.ts"
import { Recollection } from "../memory/Recollection.ts"
import { BusyModes } from "../modes/BusyModes.ts"
import type { ChannelId } from "../shared/Ids.ts"
import type { Provider } from "../transcription/Provider.ts"
import { SpeechToText } from "../transcription/SpeechToText.ts"
import { Speech } from "./Speech.ts"
import { Voice } from "./Voice.ts"

const MAX_BATCH = 20
const GROUP_BUFFER = 16
const IDLE_CHANNEL = Duration.minutes(30)
const TRANSCRIBE_TIMEOUT = Duration.minutes(1)

// The sidecar already waits for a pause before it sends an utterance, so the typed-message batch window would only add delay.
const BATCH_WINDOW = Duration.millis(600)

// Speech recognition writes these for silence and noise, for example "[BLANK_AUDIO]" or "(music)".
const ONLY_NOISE = /^\s*(?:[[(][^\])]*[\])]\s*)+$/

interface Item extends Speech.Heard {
  readonly place: Places.Place
  readonly confident: boolean
}

const words = (text: string) => text.split(/\s+/).filter((word) => word !== "").length

/** Transcribes what people say in Wendell's voice calls and delivers it to the conversation of the call's chat. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const discord = yield* Discord.Service
    const voice = yield* Voice.Service
    const places = yield* Places.Service
    const screen = yield* Screen.Service
    const conversations = yield* Conversations.Service
    const recollection = yield* Recollection.Service
    const busyModes = yield* BusyModes.Service
    const provider = yield* SpeechToText.Service

    if (!voice.enabled) return

    if (Option.isNone(provider)) {
      return yield* Effect.logWarning("Voice is on, but transcription is off, so Wendell does not hear what people say in calls")
    }

    const transcribe = (active: Provider.Provider, utterance: Voice.Utterance) =>
      active.transcribe({ name: "utterance.wav", contentType: Option.some("audio/wav"), data: utterance.wav }).pipe(
        Effect.timeout(TRANSCRIBE_TIMEOUT),
        Effect.map((text) => Option.some(text.trim()).pipe(Option.filter((value) => value !== "" && !ONLY_NOISE.test(value)))),
        Effect.catch((cause) =>
          Effect.logWarning("Could not transcribe speech in voice", { channelId: utterance.channelId, cause }).pipe(
            Effect.as(Option.none<string>()),
          ),
        ),
      )

    const hear = Effect.fn("VoiceListener.hear")(function* (utterance: Voice.Utterance) {
      if (utterance.userId === discord.me) return Option.none<Item>()

      const speaker = yield* discord.member(utterance.guildId, utterance.userId)

      if (speaker.isBot) return Option.none<Item>()

      const text = yield* transcribe(provider.value, utterance)

      if (Option.isNone(text)) return Option.none<Item>()

      yield* Effect.logInfo("Transcribed speech in voice", { channelId: utterance.channelId, words: words(text.value) })

      const prior = yield* voice.callLines(utterance.channelId)

      yield* voice.heard(utterance.channelId, speaker.name, text.value)

      const place = yield* places.forOrigin({
        channelId: utterance.channelId,
        guildId: Option.some(utterance.guildId),
        authorId: utterance.userId,
        authorName: speaker.name,
      })

      const route = Routing.classify({
        fromBot: false,
        addressed: Routing.addressesByName(text.value),
        named: false,
        spoken: true,
        inTask: Option.isSome(place.task),
        inCall: true,
        following: true,
        goal: Option.none(),
      })

      const verdict = yield* Option.match(Routing.screenQuestion(route), {
        onNone: () => Effect.succeed<Screen.Verdict>({ skip: false, confident: false }),
        onSome: (question) =>
          screen.screenTranscript(
            place.conversation.remote,
            utterance.channelId,
            [...prior, `${speaker.name}: ${text.value}`].join("\n"),
            question,
          ),
      })

      if (verdict.skip) return Option.none<Item>()

      return Option.some<Item>({
        userId: utterance.userId,
        speaker: speaker.name,
        text: text.value,
        durationMs: utterance.durationMs,
        route,
        place,
        confident: verdict.confident,
      })
    })

    const deliver = Effect.fn("VoiceListener.deliver")(function* (channelId: ChannelId, batch: ReadonlyArray<Item>) {
      const latest = batch.at(-1)

      if (latest === undefined) return

      const conversation = latest.place.conversation
      const waiting = batch.filter(({ route, confident }) => Routing.expectsReply(route) || Routing.showsProgress(route) || confident)
      const people = [...new Map(batch.map(({ userId, speaker }) => [userId, speaker] as const))].map(([userId, name]) => ({ userId, name }))

      const recalled = yield* recollection.before({
        conversationKey: `${conversation.remote.name}/${conversation.channelId}`,
        remote: conversation.remote,
        place: { guildId: conversation.guildId, channelId: conversation.channelId },
        people,
        text: batch.map(({ speaker, text }) => `${speaker}: ${text}`).join("\n"),
      })

      yield* conversations.deliver(conversation, [...recalled.blocks, Speech.renderBatch(batch)].join("\n\n"), {
        expectReply: batch.some(({ route }) => Routing.expectsReply(route)),
        progress: waiting.length > 0,
        lazyProgress: true,
        trigger: Option.none(),
        busy: waiting.length > 0 ? yield* busyModes.modeFor(conversation.remote, channelId) : "wait",
      })
      yield* recalled.delivered
      yield* Effect.logInfo("Delivered speech", { server: conversation.remote.name, channelId, count: batch.length })
    })

    const perChannel = (channelId: ChannelId, utterances: Stream.Stream<Voice.Utterance>) =>
      utterances.pipe(
        Stream.mapEffect((utterance) =>
          hear(utterance).pipe(
            Effect.catch((cause) => Effect.logError("Could not route speech", { channelId, cause }).pipe(Effect.as(Option.none<Item>()))),
          ),
        ),
        Stream.filter(Option.isSome),
        Stream.map((item) => item.value),
        Stream.groupedWithin(MAX_BATCH, BATCH_WINDOW),
        Stream.mapEffect((batch) =>
          deliver(channelId, batch).pipe(Effect.catch((cause) => Effect.logError("Could not deliver speech", { channelId, cause }))),
        ),
      )

    yield* voice.utterances.pipe(
      Stream.groupByKey((utterance) => utterance.channelId, { bufferSize: GROUP_BUFFER, idleTimeToLive: IDLE_CHANNEL }),
      Stream.flatMap(([channelId, utterances]) => perChannel(channelId, utterances), { concurrency: "unbounded" }),
      Stream.runDrain,
      Effect.forkScoped,
    )
  }),
)

export * as VoiceListener from "./VoiceListener.ts"
