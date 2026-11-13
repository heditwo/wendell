import { Duration, Effect, Layer, Option, Stream } from "effect"
import { Settings } from "../config/Settings.ts"
import { Activity } from "../conversations/Activity.ts"
import { Conversations } from "../conversations/Conversations.ts"
import { Source } from "../conversations/Conversation.ts"
import { Places } from "../conversations/Places.ts"
import { Discord } from "../discord/Discord.ts"
import { Capture } from "../memory/Capture.ts"
import { Recollection } from "../memory/Recollection.ts"
import { BusyModes } from "../modes/BusyModes.ts"
import { Fleet } from "../opencode/Fleet.ts"
import { Batcher } from "../shared/Batcher.ts"
import type { ChannelId } from "../shared/Ids.ts"
import { Attachments } from "./Attachments.ts"
import { Elsewhere } from "./Elsewhere.ts"
import { Inbound } from "./Inbound.ts"
import { Recent } from "./Recent.ts"
import { RecentPlaces } from "./RecentPlaces.ts"
import { Room } from "./Room.ts"
import { Routing } from "./Routing.ts"
import { Screen } from "./Screen.ts"
import { Transcriber } from "../transcription/Transcriber.ts"
import { Calls } from "../voice/Calls.ts"

const MAX_BATCH = 20
const GROUP_BUFFER = 64
const IDLE_CHANNEL = Duration.minutes(30)
const PROMPT_WINDOW = Duration.millis(500)
const CALL_SKIP_BELOW = 0.5

interface Item extends Omit<Inbound.Routed, "files"> {
  readonly place: Places.Place
  /** The screen's score for the message is at least `WENDELL_ENGAGE_ABOVE`. */
  readonly confident: boolean
  /** The author is in the voice call of the conversation. */
  readonly inCall: boolean
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const discord = yield* Discord.Service
    const fleet = yield* Fleet.Service
    const activity = yield* Activity.Service
    const conversations = yield* Conversations.Service
    const screen = yield* Screen.Service
    const places = yield* Places.Service
    const recent = yield* Recent.Service
    const recentPlaces = yield* RecentPlaces.Service
    const elsewhere = yield* Elsewhere.Service
    const attachments = yield* Attachments.Service
    const transcriber = yield* Transcriber.Service
    const busyModes = yield* BusyModes.Service
    const recollection = yield* Recollection.Service
    const room = yield* Room.Service
    const capture = yield* Capture.Service
    const calls = yield* Calls.Service

    const following = Effect.fn("Listener.following")(function* (channelId: ChannelId, place: Places.Place) {
      if (yield* activity.spokeWithin(channelId, settings.followWindow)) return true

      if (!place.isThread) return false

      return yield* conversations.exists(place.conversation).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not check conversation", { channelId, cause }).pipe(Effect.as(false)),
        ),
      )
    })

    const route = Effect.fn("Listener.route")(function* (received: Inbound.Message) {
      const message: Inbound.Message = received.authorIsBot
        ? received
        : { ...received, transcript: yield* transcriber.transcribe(received) }

      if (!message.authorIsBot) {
        yield* recent.record(message)
        yield* recentPlaces.record(message)
      }

      const place = yield* places.forMessage(message)
      const conversation = place.conversation
      const call = yield* calls.ofHome(conversation.remote.name, conversation.channelId)

      const people = Option.isSome(call) && !message.authorIsBot ? yield* calls.people(call.value) : []
      const inCall = people.some((person) => person.userId === message.authorId)

      const addressed =
        Inbound.isDirect(message) || message.mentionsMe || message.repliesToMe || Routing.addressesByName(Inbound.words(message))

      const quiet = message.authorIsBot || addressed

      // In a task thread, every message is about the task, so the task's rule stays.
      const talksInCall = inCall && !quiet && Option.isNone(place.task)

      const candidate = Routing.classify(
        talksInCall
          ? {
              fromBot: false,
              addressed: false,
              named: false,
              spoken: false,
              inTask: false,
              inCall: true,
              // In another channel, a person who is alone in the call can also write to people who are not in it.
              alone: people.length === 1 && Option.exists(call, (found) => found.channelId === message.channelId),
              following: false,
              goal: Option.none(),
            }
          : {
              fromBot: message.authorIsBot,
              addressed,
              named: !quiet && Routing.mentionsName(Inbound.words(message)),
              spoken: !quiet && Option.isSome(message.transcript),
              inTask: Option.isSome(place.task),
              inCall: false,
              alone: false,
              following: quiet ? false : yield* following(message.channelId, place),
              goal: quiet ? Option.none() : place.goal,
            },
      )

      const screened = (question: string) =>
        talksInCall && Option.isSome(call)
          ? Effect.gen(function* () {
              const lines = yield* calls.lines(call.value)

              return yield* screen.screenTranscript(
                conversation.remote,
                message.channelId,
                [...lines, `${message.authorName} (typed): ${Inbound.plainText(message)}`].join("\n"),
                question,
                (yield* calls.attentive(call.value)) ? undefined : CALL_SKIP_BELOW,
              )
            })
          : screen.screen(conversation.remote, message, question)

      const verdict = yield* Option.match(Routing.screenQuestion(candidate), {
        onNone: () => Effect.succeed<Screen.Verdict>({ skip: false, confident: false }),
        onSome: screened,
      })

      const routeTaken = verdict.skip ? Routing.Route.Ignored() : candidate

      if (Option.isSome(call) && inCall) {
        yield* calls.heard(
          call.value,
          { speaker: message.authorName, text: Inbound.plainText(message), typed: true },
          !verdict.skip,
        )
      }

      // A skipped line of a person in the call is already in the call's context.
      if (!message.authorIsBot && !inCall && Routing.Route.$is("Ignored")(routeTaken)) {
        yield* room.overheard(message.channelId === conversation.channelId ? message : { ...message, channelId: conversation.channelId })
      }

      return { message, place, route: routeTaken, confident: verdict.confident, inCall } satisfies Item
    })

    const deliver = Effect.fn("Listener.deliver")(function* (channelId: ChannelId, batch: ReadonlyArray<Item>) {
      const latest = batch.at(-1)

      if (latest === undefined) return

      const [first = latest] = batch

      const conversation = latest.place.conversation

      const routed = yield* Effect.forEach(batch, (item) =>
        (item.message.attachments.length === 0
          ? Effect.succeed<ReadonlyArray<Inbound.FileNote>>([])
          : attachments.save(conversation.remote, conversation.directory, item.message)
        ).pipe(Effect.map((files): Inbound.Routed => ({ message: item.message, route: item.route, files }))),
      )

      const waiting = batch.filter(
        ({ route, confident }) => Routing.expectsReply(route) || Routing.showsProgress(route) || confident,
      )

      // Without a clear signal, 👀 and typing go on the latest message once Wendell starts to work on it.
      const trigger = Option.fromUndefinedOr(waiting.at(-1) ?? latest).pipe(
        Option.map(({ message }) => ({ channelId, messageId: message.id })),
      )

      const people = [
        ...new Map(
          batch.flatMap(({ message }) => (message.authorIsBot ? [] : [[message.authorId, message.authorName] as const])),
        ),
      ].map(([userId, name]) => ({ userId, name }))

      const [recalled, found] = yield* Effect.all(
        [
          recollection.before({
            conversationKey: `${conversation.remote.name}/${conversation.channelId}`,
            remote: conversation.remote,
            place: { guildId: conversation.guildId, channelId: conversation.channelId },
            people,
            text: batch.map(({ message }) => `${message.authorName}: ${Inbound.plainText(message)}`).join("\n"),
          }),
          elsewhere.forDm(
            conversation,
            batch.map(({ message }) => message),
          ),
        ],
        { concurrency: 2 },
      )

      const asked = Option.fromUndefinedOr(waiting.at(-1))

      // Started now and awaited when the turn begins, so the prediction does not delay delivery.
      const typeAtOnce = yield* Option.match(asked, {
        onNone: () => Effect.succeed(Effect.succeed(false)),
        onSome: ({ message }) => Effect.cached(screen.needsWords(conversation.remote, message)),
      })

      yield* Effect.forkDetach(typeAtOnce)

      const overheard = yield* room.take(conversation)
      const call = yield* calls.ofHome(conversation.remote.name, conversation.channelId)
      const notice = yield* calls.notice(conversation)
      const missed = Option.isSome(call) ? yield* calls.takeOverheard(call.value) : []

      yield* conversations.deliver(
        conversation,
        [
          ...recalled.blocks,
          ...overheard.blocks,
          ...found.blocks,
          ...notice.blocks,
          ...missed,
          Inbound.renderBatch(routed),
        ].join("\n\n"),
        {
          expectReply: batch.some(({ route }) => Routing.expectsReply(route)),
          progress: waiting.length > 0,
          lazyProgress: true,
          typeAtOnce,
          trigger,
          // Only messages that ask for Wendell's attention may interrupt him; ambient chatter waits.
          busy: waiting.length > 0 ? yield* busyModes.modeFor(conversation.remote, conversation.channelId) : "wait",
          source: Source.Chat({ channelId, authors: people.map(({ userId }) => userId) }),
          chat: channelId,
        },
        [...overheard.images, ...found.images, ...routed.flatMap(({ files }) => Attachments.images(files))],
      )
      yield* recalled.delivered
      yield* found.delivered
      yield* notice.delivered

      if (first.message.channelId === conversation.channelId) yield* capture.touch(conversation, first.message.id)

      yield* Effect.logInfo("Delivered messages", {
        server: conversation.remote.name,
        kind: conversation.kind,
        channelId,
        count: batch.length,
      })
    })

    const perChannel = (channelId: ChannelId, messages: Stream.Stream<Inbound.Message>) =>
      messages.pipe(
        Stream.mapEffect((message) =>
          route(message).pipe(
            Effect.map(Option.some),
            Effect.catch((cause) => Effect.logError("Could not route a message", { channelId, cause }).pipe(Effect.as(Option.none<Item>()))),
          ),
        ),
        Stream.flatMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (item: Item) => (Routing.isActionable(item.route) ? Stream.succeed(item) : Stream.empty),
          }),
        ),
        Batcher.batches<Item>({
          max: MAX_BATCH,
          windowOf: (item) => (Routing.Route.$is("Addressed")(item.route) || item.inCall ? PROMPT_WINDOW : settings.batchWindow),
        }),
        Stream.mapEffect((batch) =>
          deliver(channelId, batch).pipe(
            Effect.catch((cause) => Effect.logError("Could not deliver messages", { channelId, cause })),
          ),
        ),
      )

    yield* discord.messages.pipe(
      Stream.groupByKey((message) => message.channelId, { bufferSize: GROUP_BUFFER, idleTimeToLive: IDLE_CHANNEL }),
      Stream.flatMap(([channelId, messages]) => perChannel(channelId, messages), { concurrency: "unbounded" }),
      Stream.runDrain,
      Effect.forkScoped,
    )

    yield* Effect.logInfo("Wendell is listening", { servers: fleet.remotes.map((remote) => remote.name) })
  }),
)

export * as Listener from "./Listener.ts"
