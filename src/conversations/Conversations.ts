import { AbsolutePath, type Session, SessionMessage } from "@opencode/client/effect"
import { Clock, Context, Deferred, Duration, Effect, Layer, Option } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Settings } from "../config/Settings.ts"
import { Discord } from "../discord/Discord.ts"
import { Fleet } from "../opencode/Fleet.ts"
import type { Models } from "../opencode/Models.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { type Conversation, type ConversationError, conversationError, type Turn } from "./Conversation.ts"
import { Sessions } from "./Sessions.ts"
import { TurnWatcher } from "./TurnWatcher.ts"

const WATCHER_READY = Duration.seconds(10)

export interface Interface {
  readonly exists: (conversation: Conversation) => Effect.Effect<boolean, ConversationError>
  /** `images` are absolute paths on the server. The model sees them with the prompt. */
  readonly deliver: (
    conversation: Conversation,
    text: string,
    turn: Turn,
    images?: ReadonlyArray<AbsolutePath>,
  ) => Effect.Effect<void, ConversationError>
  /** The conversation behind one of Wendell's sessions, if it was prepared by this process. */
  readonly forSession: (server: string, sessionID: string) => Effect.Effect<Option.Option<Conversation>>
  /** Wendell's session at the top of a subagent tree, or none when the session is not Wendell's. */
  readonly rootOf: (remote: Fleet.Remote, sessionID: string) => Effect.Effect<Option.Option<string>>
  /** Remembers the model for this conversation and switches its session, if it has one yet. */
  readonly setModel: (conversation: Conversation, model: Models.Resolved) => Effect.Effect<void, ConversationError>
  /** The session's model, or the model that a new session would get. None means the agent's default. */
  readonly currentModel: (conversation: Conversation) => Effect.Effect<Option.Option<string>, ConversationError>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Conversations") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const discord = yield* Discord.Service
    const tasks = yield* Tasks.Service
    const fleet = yield* Fleet.Service
    const scope = yield* Effect.scope
    const sessions = yield* Sessions.make
    const watcher = yield* TurnWatcher.make(sessions)

    // A schedule can fire after a restart, before anyone writes. Its session needs Wendell's tools already.
    const attachKnown = Effect.fn("Conversations.attachKnown")(function* (remote: Fleet.Remote) {
      const listing = yield* remote.client.file.list({ location: { directory: remote.directory } }).pipe(
        Effect.map((page) => page.data),
        Effect.orElseSucceed(() => []),
      )

      const dms = listing.flatMap((entry) =>
        entry.type === "directory" && path.basename(entry.path).startsWith("dm-") ? [path.join(remote.directory, entry.path)] : [],
      )

      const directories = new Set([
        ...dms,
        ...(yield* tasks.all).flatMap((task) => (task.server === remote.name ? [task.directory] : [])),
      ])

      yield* Effect.forEach(directories, (directory) => fleet.attach(remote, AbsolutePath.make(directory)), { discard: true })
      yield* Effect.logInfo("Attached Wendell's tools to known conversations", { server: remote.name, directories: directories.size + 1 })
    })

    yield* Effect.forEach(
      fleet.remotes,
      (remote) =>
        Effect.all([attachKnown(remote), watcher.watchForeign(remote)], { concurrency: 2, discard: true }).pipe(Effect.forkIn(scope)),
      { discard: true },
    )

    // A steered message is read at the agent's next step. A long command or a long model step can delay that,
    // so after a short wait the running step is interrupted and the steered message runs next.
    const interruptIfUnread = Effect.fn("Conversations.interruptIfUnread")(function* (
      conversation: Conversation,
      sessionID: Session.ID,
      inboxID: SessionMessage.ID,
    ) {
      yield* Effect.sleep(settings.interruptAfter)

      const inbox = yield* conversation.remote.client.session.inbox.list({ sessionID })

      if (!inbox.some((item) => item.id === inboxID)) return

      const { interrupted } = yield* conversation.remote.client.session.interrupt({ sessionID, resume: true })

      if (!interrupted) return

      yield* Effect.logInfo("Interrupted a turn for a new message", { server: conversation.remote.name, channelId: conversation.channelId })
      yield* discord.send(conversation.channelId, "-# Stopped to read your message.", Option.none()).pipe(Effect.ignore)
    }, Effect.catch((cause) => Effect.logWarning("Could not interrupt for a new message", { cause })))

    const deliver = Effect.fn("Conversations.deliver")(
      function* (conversation: Conversation, text: string, turn: Turn, images: ReadonlyArray<AbsolutePath> = []) {
        const sessionID = yield* sessions.ensure(conversation)
        const inboxID = SessionMessage.ID.create()
        const since = yield* Clock.currentTimeMillis
        const ready = yield* Deferred.make<void>()

        yield* watcher.own(inboxID)
        yield* watcher.follow(conversation, sessionID, Option.some(inboxID), turn, since, ready)
        yield* Deferred.await(ready).pipe(Effect.timeout(WATCHER_READY), Effect.ignore)

        const busy = turn.busy ?? "wait"

        yield* conversation.remote.client.session.prompt({
          sessionID,
          id: inboxID,
          text,
          files: images.length === 0 ? undefined : images.map((image) => ({ uri: pathToFileURL(image).href, name: path.basename(image) })),
          delivery: busy === "wait" ? "queue" : "steer",
        })

        if (busy === "interrupt") yield* interruptIfUnread(conversation, sessionID, inboxID).pipe(Effect.forkIn(scope))
      },
      (effect, conversation) => conversationError("Conversations.deliver", conversation)(effect),
    )

    return Service.of({
      exists: sessions.exists,
      deliver,
      forSession: sessions.forSession,
      rootOf: sessions.rootOf,
      setModel: sessions.setModel,
      currentModel: sessions.currentModel,
    })
  }),
)

export * as Conversations from "./Conversations.ts"
