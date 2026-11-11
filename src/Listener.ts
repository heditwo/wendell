import { Duration, Effect, Layer, Option, Stream } from "effect"
import { Activity } from "./Activity.ts"
import { Conversations } from "./Conversations.ts"
import { Discord } from "./Discord.ts"
import { Fleet } from "./Fleet.ts"
import type { ChannelId } from "./Ids.ts"
import { Inbound } from "./Inbound.ts"
import { Media } from "./Media.ts"
import { Places } from "./Places.ts"
import { Recent } from "./Recent.ts"
import { Recollection } from "./Recollection.ts"
import { Routing } from "./Routing.ts"
import { Screen } from "./Screen.ts"
import { Transcriber } from "./Transcriber.ts"
import { BusyModes } from "./BusyModes.ts"
import { Settings } from "./Settings.ts"

const MAX_BATCH = 20
const GROUP_BUFFER = 64
const IDLE_CHANNEL = Duration.minutes(30)

interface Item extends Omit<Inbound.Routed, "files"> {
  readonly place: Places.Place
  /** The screen is quite sure that the message is for Wendell. */
  readonly confident: boolean
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
    const media = yield* Media.Service
    const transcriber = yield* Transcriber.Service
    const busyModes = yield* BusyModes.Service
    const recollection = yield* Recollection.Service

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

      if (!message.authorIsBot) yield* recent.record(message)

      const place = yield* places.forMessage(message)

      const addressed =
        Inbound.isDirect(message) || message.mentionsMe || message.repliesToMe || Routing.addressesByName(Inbound.words(message))

      const quiet = message.authorIsBot || addressed

      const candidate = Routing.classify({
        fromBot: message.authorIsBot,
        addressed,
        named: !quiet && Routing.mentionsName(Inbound.words(message)),
        spoken: !quiet && Option.isSome(message.transcript),
        inTask: Option.isSome(place.task),
        following: quiet ? false : yield* following(message.channelId, place),
        goal: quiet ? Option.none() : place.goal,
      })

      const verdict = yield* Option.match(Routing.screenQuestion(candidate), {
        onNone: () => Effect.succeed<Screen.Verdict>({ skip: false, confident: false }),
        onSome: (question) => screen.screen(place.conversation.remote, message, question),
      })

      const routeTaken = verdict.skip ? Routing.Route.Ignored() : candidate

      if (!message.authorIsBot && Routing.Route.$is("Ignored")(routeTaken)) yield* recollection.overheard(message)

      return { message, place, route: routeTaken, confident: verdict.confident } satisfies Item
    })

    const deliver = Effect.fn("Listener.deliver")(function* (channelId: ChannelId, batch: ReadonlyArray<Item>) {
      const latest = batch.at(-1)

      if (latest === undefined) return

      const conversation = latest.place.conversation

      const routed = yield* Effect.forEach(batch, (item) =>
        (item.message.attachments.length === 0
          ? Effect.succeed<ReadonlyArray<Inbound.FileNote>>([])
          : media.saveIncoming(conversation.remote, conversation.directory, item.message)
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

      const recalled = yield* recollection.before(
        `${conversation.remote.name}/${conversation.channelId}`,
        { guildId: conversation.guildId, channelId: conversation.channelId },
        people,
      )

      yield* conversations.deliver(
        conversation,
        [...recalled, Inbound.renderBatch(routed)].join("\n\n"),
        {
          expectReply: batch.some(({ route }) => Routing.expectsReply(route)),
          progress: waiting.length > 0,
          lazyProgress: true,
          trigger,
          // Only messages that ask for Wendell's attention may interrupt him; ambient chatter waits.
          busy: waiting.length > 0 ? yield* busyModes.modeFor(conversation.remote, channelId) : "wait",
        },
        routed.flatMap(({ files }) => Media.images(files)),
      )
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
        Stream.groupedWithin(MAX_BATCH, settings.batchWindow),
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
