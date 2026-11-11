import { type AbsolutePath, Agent, type Session, SessionMessage } from "@opencode/client/effect"
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { Activity } from "./Activity.ts"
import { Discord } from "./Discord.ts"
import { Fleet } from "./Fleet.ts"
import type { ChannelId, GuildId, MessageId } from "./Ids.ts"
import { Policy } from "./Policy.ts"
import { Progress } from "./Progress.ts"
import { SessionKey } from "./SessionKey.ts"
import { Settings } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"

const PERSONA_KEY = "wendell"
const CONTEXT_KEY = "wendell-conversation"
const TURN_TIMEOUT = Duration.minutes(30)
const TYPING_EVERY = Duration.seconds(8)
const STATUS_EDIT_EVERY = 1_500
const RECENT_TASKS = 15
const WATCHING = "👀"
const MAX_SESSION_DEPTH = 8

export type Kind = "channel" | "task" | "dm"

/** Where a Discord conversation lives on an OpenCode server. */
export interface Conversation {
  readonly kind: Kind
  readonly channelId: ChannelId
  readonly guildId: Option.Option<GuildId>
  readonly remote: Fleet.Remote
  readonly directory: AbsolutePath
  readonly tier: Policy.Tier
  readonly title: string
}

export interface Turn {
  /** Someone is waiting: never end in silence. */
  readonly expectReply: boolean
  /** Show 👀, typing and a live status line while Wendell works. */
  readonly progress: boolean
  readonly trigger: Option.Option<{ readonly channelId: ChannelId; readonly messageId: MessageId }>
}

export class ConversationError extends Schema.TaggedError<ConversationError>()("Conversations.ConversationError", {
  operation: Schema.String,
  server: Schema.String,
  channelId: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly exists: (conversation: Conversation) => Effect.Effect<boolean, ConversationError>
  readonly deliver: (conversation: Conversation, text: string, turn: Turn) => Effect.Effect<void, ConversationError>
  /** The conversation behind one of Wendell's sessions, if it was prepared by this process. */
  readonly forSession: (server: string, sessionID: string) => Effect.Effect<Option.Option<Conversation>>
  /** Wendell's session at the top of a subagent tree, or none when the session is not Wendell's. */
  readonly rootOf: (remote: Fleet.Remote, sessionID: string) => Effect.Effect<Option.Option<string>>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Conversations") {}

const conversationError =
  (operation: string, conversation: Conversation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(
      effect,
      (cause) =>
        new ConversationError({ operation, server: conversation.remote.name, channelId: conversation.channelId, cause }),
    )

const formatDate = (time: number) => new Date(time).toISOString().slice(0, 10)

const describeTasks = (tasks: ReadonlyArray<Tasks.Task>) =>
  tasks.length === 0
    ? "There are no tasks yet."
    : tasks
        .map(
          (task) =>
            `- <#${task.threadId}> thread_id=${task.threadId} "${task.title}" (${task.status}, started by ${task.createdByName}, ` +
            `last active ${formatDate(task.lastActivity)}, directory ${task.directory}): ${task.summary}`,
        )
        .join("\n")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const fs = yield* FileSystem.FileSystem
    const discord = yield* Discord.Service
    const activity = yield* Activity.Service
    const tasks = yield* Tasks.Service
    const fleet = yield* Fleet.Service
    const scope = yield* Effect.scope
    const persona = yield* fs.readFileString(settings.personaFile).pipe(Effect.orDie)
    const prepared = yield* Ref.make(HashMap.empty<string, Conversation>())
    const contexts = yield* Ref.make(HashMap.empty<string, string>())
    const roots = yield* Ref.make(HashMap.empty<string, Option.Option<string>>())

    const rootOf = Effect.fn("Conversations.rootOf")(function* (remote: Fleet.Remote, sessionID: string) {
      const cacheKey = `${remote.name}/${sessionID}`
      const cached = HashMap.get(yield* Ref.get(roots), cacheKey)

      if (Option.isSome(cached)) return cached.value

      let current = Option.some(sessionID)

      for (let depth = 0; depth < MAX_SESSION_DEPTH && Option.isSome(current); depth += 1) {
        if (Option.isSome(SessionKey.channelOf(current.value))) break

        const info = yield* remote.client.session
          .get({ sessionID: SessionKey.forSessionID(current.value) })
          .pipe(Effect.option)

        current = Option.flatMap(info, (session) => Option.fromNullishOr(session.parentID))
      }

      const root = Option.filter(current, (id) => Option.isSome(SessionKey.channelOf(id)))

      yield* Ref.update(roots, HashMap.set(cacheKey, root))

      return root
    })

    const sessionKey = (conversation: Conversation) =>
      `${conversation.remote.name}/${SessionKey.forChannel(conversation.channelId)}`

    const contextFor = Effect.fn("Conversations.contextFor")(function* (conversation: Conversation) {
      const where = `This conversation is in Discord <#${conversation.channelId}>. Your working directory is ${conversation.directory}.`

      if (conversation.kind === "task") {
        const task = yield* tasks.get(conversation.channelId)

        return [
          where,
          "This is a task thread: one piece of real work. Everything said here is about it.",
          ...Option.match(task, {
            onNone: () => [],
            onSome: (current) => [
              `Task: "${current.title}", started by ${current.createdByName}. Status: ${current.status}.`,
              `What you recorded so far: ${current.summary}`,
            ],
          }),
          conversation.tier === "trusted"
            ? "You can edit files and run commands in your working directory. For long-running processes such as dev servers or tunnels, use background shell jobs."
            : "The person who started this task cannot approve edits or commands, so this task is read-only.",
          "Keep the task record current with update_task after meaningful progress.",
        ].join("\n")
      }

      const recent = yield* tasks.recent(conversation.guildId, RECENT_TASKS)

      return [
        where,
        conversation.kind === "dm"
          ? "This is a private DM. You can work here directly; DMs have no threads."
          : "This is a shared channel. Answer quick questions here. For real work, call start_task to move it into its own thread.",
        conversation.tier === "trusted"
          ? "You can use the full setup here: edit files, run commands and use subagents."
          : "This conversation is read-only: commands, edits and subagents are rejected.",
        "Tasks in this server, most recent first. When someone refers to earlier work, find it here and use continue_task:",
        describeTasks(recent),
      ].join("\n")
    })

    const exists = Effect.fn("Conversations.exists")(
      function* (conversation: Conversation) {
        return yield* conversation.remote.client.session
          .get({ sessionID: SessionKey.forChannel(conversation.channelId) })
          .pipe(
            Effect.as(true),
            Effect.catchTag("SessionNotFoundError", () => Effect.succeed(false)),
          )
      },
      (effect, conversation) => conversationError("Conversations.exists", conversation)(effect),
    )

    // Permissions and persona are refreshed once per process; the conversation context whenever it changes.
    const prepare = Effect.fn("Conversations.prepare")(function* (conversation: Conversation, sessionID: Session.ID) {
      const key = sessionKey(conversation)
      const client = conversation.remote.client

      if (!HashMap.has(yield* Ref.get(prepared), key)) {
        yield* client.session.update({
          sessionID,
          permissions: Policy.sessionPermissions(conversation.tier, conversation.remote.prefs.allow ?? []),
        })
        yield* client.experimental.session.instructions.entry.put({ sessionID, key: PERSONA_KEY, value: persona })
        yield* Ref.update(prepared, HashMap.set(key, conversation))
      }

      const context = yield* contextFor(conversation)

      if (Option.getOrUndefined(HashMap.get(yield* Ref.get(contexts), key)) !== context) {
        yield* client.experimental.session.instructions.entry.put({ sessionID, key: CONTEXT_KEY, value: context })
        yield* Ref.update(contexts, HashMap.set(key, context))
      }
    })

    const ensure = Effect.fn("Conversations.ensure")(function* (conversation: Conversation) {
      const sessionID = SessionKey.forChannel(conversation.channelId)
      const { remote } = conversation

      yield* fleet.attach(remote, conversation.directory)

      if (!(yield* exists(conversation))) {
        const model = yield* Option.match(Option.fromUndefinedOr(remote.prefs.model), {
          onNone: () => Effect.succeed(undefined),
          onSome: (value) => Settings.parseModelRef(`servers.${remote.name}.model`, value),
        })

        yield* remote.client.session.create({
          id: sessionID,
          title: `Wendell · ${conversation.title}`,
          location: { directory: conversation.directory },
          agent: Option.match(Option.fromUndefinedOr(remote.prefs.agent), {
            onNone: () => undefined,
            onSome: (agent) => Agent.ID.make(agent),
          }),
          model,
          metadata: { discordChannelId: conversation.channelId, client: Policy.CLIENT_NAME, kind: conversation.kind },
          permissions: Policy.sessionPermissions(conversation.tier, remote.prefs.allow ?? []),
        })

        yield* Effect.logInfo("Started conversation", {
          server: remote.name,
          kind: conversation.kind,
          channelId: conversation.channelId,
          tier: conversation.tier,
        })
      }

      yield* prepare(conversation, sessionID)

      return sessionID
    })

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

    const ignore = <A, E>(effect: Effect.Effect<A, E>) => Effect.ignore(effect)

    // Follows one turn: shows progress, and posts the turn's text if Wendell was addressed but said nothing.
    const watchTurn = Effect.fn("Conversations.watchTurn")(function* (
      conversation: Conversation,
      sessionID: Session.ID,
      inboxID: SessionMessage.ID,
      turn: Turn,
      since: number,
      ready: Deferred.Deferred<void>,
    ) {
      const channelId = conversation.channelId
      const delivered = yield* Ref.make(false)

      const status = yield* Ref.make<{ readonly id: Option.Option<MessageId>; readonly label: string; readonly at: number }>({
        id: Option.none(),
        label: "",
        at: 0,
      })

      const typing = yield* Ref.make(Option.none<Fiber.Fiber<unknown>>())
      const outcome = yield* Deferred.make<void>()
      const failure = yield* Ref.make(Option.none<string>())

      const onDelivered = Effect.gen(function* () {
        yield* Ref.set(delivered, true)

        if (!turn.progress) return

        yield* Option.match(turn.trigger, {
          onNone: () => Effect.void,
          onSome: ({ channelId: where, messageId }) => ignore(discord.react(where, messageId, WATCHING)),
        })

        const fiber = yield* ignore(discord.typing(channelId)).pipe(
          Effect.repeat(Schedule.spaced(TYPING_EVERY)),
          Effect.forkIn(scope),
        )

        yield* Ref.set(typing, Option.some(fiber))
      })

      const onTool = (name: string, helper: boolean) =>
        Effect.gen(function* () {
          if (!turn.progress) return

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

      yield* conversation.remote.client.event
        .subscribe({
          types: [
            "session.inbox.delivered",
            "session.tool.input.started",
            "session.execution.succeeded",
            "session.execution.failed",
          ],
        })
        .pipe(
          Stream.tap((event) => (event.type === "server.connected" ? Deferred.succeed(ready, undefined) : Effect.void)),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "session.inbox.delivered") {
                if (event.data.inboxID === inboxID) yield* onDelivered

                return
              }

              if (event.type === "server.connected" || !(yield* Ref.get(delivered))) return

              if (event.type === "session.tool.input.started") {
                if (event.data.sessionID === sessionID) return yield* onTool(event.data.name, false)

                const root = yield* rootOf(conversation.remote, event.data.sessionID)

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

      if (Option.isSome(failed) && (turn.expectReply || turn.progress)) {
        yield* discord.send(channelId, `⚠️ I ran into an error: ${failed.value}`, Option.none())
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

    const deliver = Effect.fn("Conversations.deliver")(
      function* (conversation: Conversation, text: string, turn: Turn) {
        const sessionID = yield* ensure(conversation)
        const inboxID = SessionMessage.ID.create()
        const since = yield* Clock.currentTimeMillis
        const ready = yield* Deferred.make<void>()

        yield* watchTurn(conversation, sessionID, inboxID, turn, since, ready).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Turn watcher failed", { server: conversation.remote.name, channelId: conversation.channelId, cause }),
          ),
          Effect.forkIn(scope),
        )
        yield* Deferred.await(ready).pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore)
        yield* conversation.remote.client.session.prompt({ sessionID, id: inboxID, text, delivery: "queue" })
      },
      (effect, conversation) => conversationError("Conversations.deliver", conversation)(effect),
    )

    const forSession = Effect.fn("Conversations.forSession")(function* (server: string, sessionID: string) {
      return HashMap.get(yield* Ref.get(prepared), `${server}/${sessionID}`)
    })

    return Service.of({ exists, deliver, forSession, rootOf })
  }),
)

export * as Conversations from "./Conversations.ts"
