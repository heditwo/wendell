import { type Session, SessionMessage } from "@opencode/client/effect"
import { Clock, Deferred, Duration, Effect, Fiber, HashMap, HashSet, Option, Ref, Schedule, Stream } from "effect"
import { Discord } from "../discord/Discord.ts"
import type { Fleet } from "../opencode/Fleet.ts"
import { SessionKey } from "../opencode/SessionKey.ts"
import type { ChannelId, MessageId } from "../shared/Ids.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Activity } from "./Activity.ts"
import type { Conversation, Turn } from "./Conversation.ts"
import { Progress } from "./Progress.ts"
import { Sessions } from "./Sessions.ts"

const TURN_TIMEOUT = Duration.minutes(30)
const TYPING_EVERY = Duration.seconds(8)
const STATUS_EDIT_EVERY = 1_500
const WATCHING = "👀"
const LISTENER_RESTART = Duration.seconds(5)

/**
 * Follows turns: shows 👀, typing and a status line, posts errors, and posts the turn's text when someone
 * waits and Wendell said nothing. It also follows turns that Wendell did not start, such as a fired schedule.
 */
export const make = (sessions: Sessions.Interface) =>
  Effect.gen(function* () {
    const discord = yield* Discord.Service
    const activity = yield* Activity.Service
    const tasks = yield* Tasks.Service
    const scope = yield* Effect.scope
    const ours = yield* Ref.make(HashSet.empty<SessionMessage.ID>())
    const watching = yield* Ref.make(HashMap.empty<string, number>())

    const ignore = <A, E>(effect: Effect.Effect<A, E>) => Effect.ignore(effect)

    const lastText = Effect.fn("Conversations.lastText")(function* (conversation: Conversation, sessionID: Session.ID) {
      const page = yield* conversation.remote.client.message.list({
        sessionID,
        type: "assistant",
        order: "desc",
        limit: 1,
      })

      return Option.fromNullishOr(page.data[0]).pipe(
        Option.flatMap((message) => (message.type === "assistant" ? Option.some(message.content) : Option.none())),
        Option.map((content) =>
          content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .trim(),
        ),
        Option.filter((text) => text !== ""),
      )
    })

    const watchTurn = Effect.fn("Conversations.watchTurn")(function* (
      conversation: Conversation,
      sessionID: Session.ID,
      /** None for a turn that Wendell did not start, such as a schedule that fired. It is already running. */
      inboxID: Option.Option<SessionMessage.ID>,
      turn: Turn,
      since: number,
      ready: Deferred.Deferred<void>,
    ) {
      const channelId = conversation.channelId
      const foreign = Option.isNone(inboxID)
      const delivered = yield* Ref.make(false)

      const status = yield* Ref.make<{ readonly id: Option.Option<MessageId>; readonly label: string; readonly at: number }>({
        id: Option.none(),
        label: "",
        at: 0,
      })

      const typing = yield* Ref.make(Option.none<Fiber.Fiber<unknown>>())
      const outcome = yield* Deferred.make<void>()
      const failure = yield* Ref.make(Option.none<string>())

      const engaged = yield* Ref.make(false)

      const engage = Effect.gen(function* () {
        if (yield* Ref.getAndSet(engaged, true)) return

        yield* Option.match(turn.trigger, {
          onNone: () => Effect.void,
          onSome: ({ channelId: where, messageId }) => ignore(discord.react(where, messageId, WATCHING)),
        })

        const fiber = yield* ignore(discord.typing(channelId)).pipe(Effect.repeat(Schedule.spaced(TYPING_EVERY)), Effect.forkIn(scope))

        yield* Ref.set(typing, Option.some(fiber))
      })

      const onDelivered = Effect.gen(function* () {
        yield* Ref.set(delivered, true)

        if (turn.progress) yield* engage
      })

      const onTool = (name: string, helper: boolean) =>
        Effect.gen(function* () {
          // A lone reaction is a full answer, so it does not need 👀 or typing.
          if (!(yield* Ref.get(engaged)) && turn.lazyProgress === true && !name.endsWith("react")) yield* engage

          if (!(yield* Ref.get(engaged))) return

          const label = Progress.label(name).pipe(Option.map((text) => (helper ? `Helper: ${text}` : text)))

          if (Option.isNone(label)) return

          const now = yield* Clock.currentTimeMillis
          const current = yield* Ref.get(status)

          if (current.label === label.value || now - current.at < STATUS_EDIT_EVERY) return

          const text = `-# ${label.value}…`

          const id = yield* Option.match(current.id, {
            onNone: () => discord.send(channelId, text, Option.none()).pipe(Effect.map(Option.some)),
            onSome: (messageId) => discord.edit(channelId, messageId, text).pipe(Effect.as(Option.some(messageId))),
          }).pipe(Effect.orElseSucceed(() => current.id))

          yield* Ref.set(status, { id, label: label.value, at: now })
        })

      if (foreign) yield* onDelivered

      yield* conversation.remote.client.event
        .subscribe({
          types: [
            "session.inbox.delivered",
            "session.tool.input.started",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
          ],
        })
        .pipe(
          Stream.tap((event) => (event.type === "server.connected" ? Deferred.succeed(ready, undefined) : Effect.void)),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "session.inbox.delivered") {
                if (Option.contains(inboxID, event.data.inboxID)) yield* onDelivered

                return
              }

              if (event.type === "server.connected" || !(yield* Ref.get(delivered))) return

              if (event.type === "session.tool.input.started") {
                if (event.data.sessionID === sessionID) return yield* onTool(event.data.name, false)

                const root = yield* sessions.rootOf(conversation.remote, event.data.sessionID)

                return Option.contains(root, sessionID) ? yield* onTool(event.data.name, true) : undefined
              }

              if (event.data.sessionID !== sessionID) return

              if (event.type === "session.execution.failed") yield* Ref.set(failure, Option.some(event.data.error.message))

              yield* Deferred.succeed(outcome, undefined)
            }),
          ),
          Effect.raceFirst(Deferred.await(outcome)),
          Effect.timeout(TURN_TIMEOUT),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Option.match(yield* Ref.get(typing), { onNone: () => Effect.void, onSome: Fiber.interrupt })
              yield* Option.match((yield* Ref.get(status)).id, {
                onNone: () => Effect.void,
                onSome: (messageId) => ignore(discord.remove(channelId, messageId)),
              })
              yield* Option.match(turn.trigger, {
                onNone: () => Effect.void,
                onSome: ({ channelId: where, messageId }) => ignore(discord.unreact(where, messageId, WATCHING)),
              })
            }),
          ),
        )

      const failed = yield* Ref.get(failure)

      yield* tasks.touch(channelId).pipe(Effect.ignore)

      if (Option.isSome(failed) && (turn.expectReply || turn.progress || foreign)) {
        yield* discord.send(channelId, `⚠️ I ran into an error: ${failed.value}\n-# If it keeps happening, pick another model with /model.`, Option.none())
        yield* activity.spoke(channelId)

        return
      }

      if (!turn.expectReply || (yield* activity.spokeSince(channelId, since))) return

      const text = yield* lastText(conversation, sessionID)

      if (Option.isNone(text)) return

      yield* discord.send(channelId, text.value, Option.none())
      yield* activity.spoke(channelId)
      yield* Effect.logInfo("Posted the turn text because Wendell did not call wendell_reply", {
        server: conversation.remote.name,
        channelId,
      })
    })

    /**
     * Watches one turn in the background. `ready` completes once the watcher listens, so the prompt can go
     * out without missing its first events.
     */
    const follow = (
      conversation: Conversation,
      sessionID: Session.ID,
      inboxID: Option.Option<SessionMessage.ID>,
      turn: Turn,
      since: number,
      ready: Deferred.Deferred<void>,
    ) => {
      const key = Sessions.keyOf(conversation.remote.name, sessionID)

      const change = (delta: number) =>
        Ref.update(watching, (all) => HashMap.set(all, key, Option.getOrElse(HashMap.get(all, key), () => 0) + delta))

      return change(1).pipe(
        Effect.andThen(watchTurn(conversation, sessionID, inboxID, turn, since, ready)),
        Effect.ensuring(change(-1)),
        Effect.catch((cause) =>
          Effect.logWarning("Turn watcher failed", { server: conversation.remote.name, channelId: conversation.channelId, cause }),
        ),
        Effect.forkIn(scope),
      )
    }

    /** Marks a prompt as Wendell's own, so its delivery is not taken for a foreign turn. */
    const own = (inboxID: SessionMessage.ID) => Ref.update(ours, HashSet.add(inboxID))

    // A turn that Wendell did not start has no prepared conversation after a restart, so it is rebuilt from the session.
    const foreignConversation = Effect.fn("Conversations.foreignConversation")(function* (
      remote: Fleet.Remote,
      sessionID: Session.ID,
      channelId: ChannelId,
    ) {
      const known = yield* sessions.forSession(remote.name, sessionID)

      if (Option.isSome(known)) return known.value

      const session = yield* remote.client.session.get({ sessionID })
      const task = yield* tasks.get(channelId)

      return {
        kind: Option.isSome(task) ? "task" : "channel",
        channelId,
        guildId: Option.flatMap(task, (found) => Option.fromUndefinedOr(found.guildId)),
        remote,
        directory: session.location.directory,
        title: session.title ?? "",
      } satisfies Conversation
    })

    // Schedules and background jobs (such as image_generate) wake Wendell's sessions without a Discord message.
    // Their turns get the same watcher, without 👀 and without the silence fallback; errors are still posted.
    const onForeignDelivery = Effect.fn("Conversations.onForeignDelivery")(function* (
      remote: Fleet.Remote,
      sessionID: Session.ID,
      inboxID: SessionMessage.ID,
    ) {
      const channelId = SessionKey.channelOf(sessionID)

      const mine = yield* Ref.modify(ours, (all) => [HashSet.has(all, inboxID), HashSet.remove(all, inboxID)])

      if (Option.isNone(channelId) || mine) return

      if (Option.getOrElse(HashMap.get(yield* Ref.get(watching), Sessions.keyOf(remote.name, sessionID)), () => 0) > 0) return

      const conversation = yield* foreignConversation(remote, sessionID, channelId.value)
      const since = yield* Clock.currentTimeMillis
      const ready = yield* Deferred.make<void>()

      yield* Effect.logInfo("Watching a turn that Wendell did not start", { server: remote.name, channelId: channelId.value })
      yield* follow(conversation, sessionID, Option.none(), { expectReply: false, progress: false, trigger: Option.none() }, since, ready)
    })

    /** Runs for the life of the process, and restarts when the server's event stream ends. */
    const watchForeign = (remote: Fleet.Remote) =>
      remote.client.event.subscribe({ types: ["session.inbox.delivered"] }).pipe(
        Stream.runForEach((event) =>
          event.type === "session.inbox.delivered"
            ? onForeignDelivery(remote, event.data.sessionID, event.data.inboxID).pipe(
                Effect.catch((cause) => Effect.logWarning("Could not watch a turn", { server: remote.name, cause })),
              )
            : Effect.void,
        ),
        Effect.catch((cause) => Effect.logWarning("Turn listener stopped", { server: remote.name, cause })),
        Effect.repeat(Schedule.spaced(LISTENER_RESTART)),
      )

    return { follow, own, watchForeign }
  })

export * as TurnWatcher from "./TurnWatcher.ts"
