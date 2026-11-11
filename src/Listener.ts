import { Duration, Effect, Layer, Option, Stream } from "effect"
import { Access } from "./Access.ts"
import { Activity } from "./Activity.ts"
import { Conversations } from "./Conversations.ts"
import { Discord } from "./Discord.ts"
import { Fleet } from "./Fleet.ts"
import type { ChannelId } from "./Ids.ts"
import { Inbound } from "./Inbound.ts"
import { Places } from "./Places.ts"
import { Recent } from "./Recent.ts"
import { Routing } from "./Routing.ts"
import { Screen } from "./Screen.ts"
import { Settings } from "./Settings.ts"

const MAX_BATCH = 20
const GROUP_BUFFER = 64
const IDLE_CHANNEL = Duration.minutes(30)

interface Item extends Inbound.Routed {
  readonly place: Places.Place
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
    const access = yield* Access.Service
    const recent = yield* Recent.Service

    const following = Effect.fn("Listener.following")(function* (channelId: ChannelId, place: Places.Place) {
      if (yield* activity.spokeWithin(channelId, settings.followWindow)) return true

      if (!place.isThread) return false

      return yield* conversations.exists(place.conversation).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not check conversation", { channelId, cause }).pipe(Effect.as(false)),
        ),
      )
    })

    const route = Effect.fn("Listener.route")(function* (message: Inbound.Message) {
      if (!message.authorIsBot) yield* recent.record(message)

      const place = yield* places.forMessage(message)

      const addressed =
        Inbound.isDirect(message) || message.mentionsMe || message.repliesToMe || Routing.addressesByName(message.content)

      const quiet = message.authorIsBot || addressed

      const candidate = Routing.classify({
        fromBot: message.authorIsBot,
        addressed,
        named: !quiet && Routing.mentionsName(message.content),
        inTask: Option.isSome(place.task),
        following: quiet ? false : yield* following(message.channelId, place),
        goal: quiet ? Option.none() : place.goal,
      })

      const skip = yield* Option.match(Routing.screenQuestion(candidate), {
        onNone: () => Effect.succeed(false),
        onSome: (question) => screen.shouldSkip(place.conversation.remote, message, question),
      })

      const routeTaken = skip ? Routing.Route.Ignored() : candidate
      const trusted = Routing.isActionable(routeTaken) ? yield* access.trusted(Inbound.member(message)) : false

      return { message, place, route: routeTaken, trusted } satisfies Item
    })

    const deliver = Effect.fn("Listener.deliver")(function* (channelId: ChannelId, batch: ReadonlyArray<Item>) {
      const latest = batch.at(-1)

      if (latest === undefined) return

      const conversation = latest.place.conversation
      const waiting = batch.filter(({ route }) => Routing.expectsReply(route) || Routing.showsProgress(route))

      const trigger = Option.fromUndefinedOr(waiting.at(-1)).pipe(
        Option.map(({ message }) => ({ channelId, messageId: message.id })),
      )

      yield* conversations.deliver(conversation, Inbound.renderBatch(batch), {
        expectReply: batch.some(({ route }) => Routing.expectsReply(route)),
        progress: waiting.length > 0,
        trigger,
      })
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
