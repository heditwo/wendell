import { AbsolutePath, Agent, type Model, type Session, SessionMessage } from "@opencode/client/effect"
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  HashMap,
  HashSet,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Activity } from "./Activity.ts"
import { Discord } from "./Discord.ts"
import { Fleet } from "./Fleet.ts"
import type { ChannelId, GuildId, MessageId } from "./Ids.ts"
import { Models } from "./Models.ts"
import { Policy } from "./Policy.ts"
import { Progress } from "./Progress.ts"
import { SessionKey } from "./SessionKey.ts"
import { Settings } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { WendellConfig } from "./WendellConfig.ts"

const PERSONA_KEY = "wendell"
const CONTEXT_KEY = "wendell-conversation"
const TURN_TIMEOUT = Duration.minutes(30)
const TYPING_EVERY = Duration.seconds(8)
const STATUS_EDIT_EVERY = 1_500
const RECENT_TASKS = 15
const WATCHING = "👀"
const MAX_SESSION_DEPTH = 8
const LISTENER_RESTART = Duration.seconds(5)

export type Kind = "channel" | "task" | "dm"

/** Where a Discord conversation lives on an OpenCode server. */
export interface Conversation {
  readonly kind: Kind
  readonly channelId: ChannelId
  readonly guildId: Option.Option<GuildId>
  readonly remote: Fleet.Remote
  readonly directory: AbsolutePath
  readonly title: string
}

export interface Turn {
  /** Someone is waiting: never end in silence. */
  readonly expectReply: boolean
  /** Show 👀, typing and a live status line while Wendell works. */
  readonly progress: boolean
  readonly trigger: Option.Option<{ readonly channelId: ChannelId; readonly messageId: MessageId }>
  /** How to deliver while a turn is running. Default: `wait`, for Wendell's own hand-offs and reports. */
  readonly busy?: WendellConfig.BusyMode | undefined
}

export class ConversationError extends Schema.TaggedError<ConversationError>()("Conversations.ConversationError", {
  operation: Schema.String,
  server: Schema.String,
  channelId: Schema.String,
  cause: Schema.Defect(),
}) {}

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

const conversationError =
  (operation: string, conversation: Conversation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(
      effect,
      (cause) =>
        new ConversationError({ operation, server: conversation.remote.name, channelId: conversation.channelId, cause }),
    )

export const formatModel = (model: Model.Ref) =>
  `${model.providerID}/${model.id}${model.variant === undefined || model.variant === "default" ? "" : `#${model.variant}`}`

const formatDate = (time: number) => new Date(time).toISOString().slice(0, 10)

const describeTask = (task: Tasks.Task) =>
  `<#${task.threadId}> thread_id=${task.threadId} "${task.title}" (${task.status}, started by ${task.createdByName}, ` +
  `last active ${formatDate(task.lastActivity)}, directory ${task.directory}): ${task.summary}`

const describeTasks = (tasks: ReadonlyArray<Tasks.Task>) => {
  if (tasks.length === 0) return "There are no tasks yet."

  const listed = new Set(tasks.map((task) => task.threadId))

  const isTop = (task: Tasks.Task) => task.parentTaskId === undefined || !listed.has(task.parentTaskId)

  const lines = (task: Tasks.Task, depth: number): ReadonlyArray<string> => [
    `${"  ".repeat(depth)}- ${describeTask(task)}` +
      (depth === 0 && task.parentTaskId !== undefined ? ` (sub-task of <#${task.parentTaskId}>)` : ""),
    ...tasks.filter((child) => child.parentTaskId === task.threadId).flatMap((child) => lines(child, depth + 1)),
  ]

  return tasks
    .filter(isTop)
    .flatMap((task) => lines(task, 0))
    .join("\n")
}

const describeSubtask = (task: Tasks.Task) =>
  `- <#${task.threadId}> thread_id=${task.threadId} "${task.title}" (${task.status}, directory ${task.directory}` +
  `${task.branch === undefined ? "" : `, branch ${task.branch}`}): ${task.summary}`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const fs = yield* FileSystem.FileSystem
    const discord = yield* Discord.Service
    const activity = yield* Activity.Service
    const tasks = yield* Tasks.Service
    const fleet = yield* Fleet.Service
    const models = yield* Models.Service
    const config = yield* WendellConfig.Service
    const scope = yield* Effect.scope
    const persona = yield* fs.readFileString(settings.personaFile).pipe(Effect.orDie)
    const prepared = yield* Ref.make(HashMap.empty<string, Conversation>())
    const contexts = yield* Ref.make(HashMap.empty<string, string>())
    const roots = yield* Ref.make(HashMap.empty<string, Option.Option<string>>())
    const ours = yield* Ref.make(HashSet.empty<SessionMessage.ID>())
    const watching = yield* Ref.make(HashMap.empty<string, number>())

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
      const model = Option.match(yield* models.chosen(conversation.remote, conversation.channelId), {
        onNone: () => "the agent's default model",
        onSome: (ref) => ref,
      })

      const where = [
        `This conversation is in Discord <#${conversation.channelId}>. Your working directory is ${conversation.directory}.`,
        `Your model here: ${model}. When someone asks for another model, use set_model.`,
        `People's time zone is ${settings.timeZone} unless they say otherwise. Pass it as tz to schedule_create.`,
      ].join("\n")

      if (conversation.kind === "task") {
        const task = yield* tasks.get(conversation.channelId)
        const subtasks = yield* tasks.subtasks(conversation.channelId)

        const parent = yield* Option.match(Option.flatMap(task, (current) => Option.fromUndefinedOr(current.parentTaskId)), {
          onNone: () => Effect.succeed(Option.none<Tasks.Task>()),
          onSome: tasks.get,
        })

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
          ...Option.match(parent, {
            onNone: () => [],
            onSome: (owner) => [
              `This is a sub-task of <#${owner.threadId}> "${owner.title}": ${owner.summary}`,
              Option.exists(task, (current) => current.directory === owner.directory)
                ? "You share the directory with the parent task. Only touch what your brief assigns you."
                : "You work in your own git worktree. Commit your work on your branch so the parent task can merge it.",
              'When you call update_task with status "done", your summary is reported to the parent task automatically.',
            ],
          }),
          "You can edit files and run commands in your working directory. For long-running processes such as dev servers or tunnels, use background shell jobs.",
          "Keep the task record current with update_task after meaningful progress.",
          "For a large, independent part of the work, call start_task without message_id to start a sub-task in its own thread.",
          ...(subtasks.length === 0
            ? []
            : ["Sub-tasks of this task, oldest first. They report here when they are done:", ...subtasks.map(describeSubtask)]),
        ].join("\n")
      }

      const recent = yield* tasks.recent(conversation.guildId, RECENT_TASKS)

      return [
        where,
        conversation.kind === "dm"
          ? "This is a private DM. You can work here directly; DMs have no threads."
          : "This is a shared channel. Answer quick questions here. For real work, call start_task to move it into its own thread.",
        "You can use the full setup here: edit files, run commands and use subagents.",
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

    const pickModel = (conversation: Conversation) =>
      models.pick(conversation.remote, conversation.channelId).pipe(
        Effect.tapErrorTag("Models.NoAllowedModel", (error) =>
          Effect.logError(error.message, { channelId: conversation.channelId }),
        ),
      )

    // Sessions from older versions, or changed by hand, can be on a provider that is now blocked.
    const unblock = Effect.fn("Conversations.unblock")(function* (conversation: Conversation, sessionID: Session.ID) {
      const { remote } = conversation
      const session = yield* remote.client.session.get({ sessionID })
      const current = Option.fromUndefinedOr(session.model).pipe(Option.map(formatModel))

      if (!Option.exists(current, (model) => WendellConfig.isBlocked(remote.prefs, model))) return

      const next = yield* pickModel(conversation)

      if (Option.isNone(next)) return

      yield* remote.client.session.switchModel({ sessionID, model: next.value })
      yield* Effect.logWarning("Moved a session off a blocked provider", {
        server: remote.name,
        channelId: conversation.channelId,
        model: formatModel(next.value),
      })
    })

    // Permissions and persona are refreshed once per process; the conversation context whenever it changes.
    const prepare = Effect.fn("Conversations.prepare")(function* (conversation: Conversation, sessionID: Session.ID) {
      const key = sessionKey(conversation)
      const client = conversation.remote.client

      if (!HashMap.has(yield* Ref.get(prepared), key)) {
        yield* client.session.update({
          sessionID,
          permissions: Policy.sessionPermissions(conversation.remote.prefs.allow ?? []),
          // Also hides sessions that older versions of Wendell created.
          archived: config.hideSessions ? true : undefined,
        })
        yield* client.experimental.session.instructions.entry.put({ sessionID, key: PERSONA_KEY, value: persona })
        yield* unblock(conversation, sessionID)
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
        const model = Option.getOrUndefined(yield* pickModel(conversation))

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
          permissions: Policy.sessionPermissions(remote.prefs.allow ?? []),
        })

        if (config.hideSessions) yield* remote.client.session.update({ sessionID, archived: true })

        yield* Effect.logInfo("Started conversation", {
          server: remote.name,
          kind: conversation.kind,
          channelId: conversation.channelId,
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

    const watched = (
      conversation: Conversation,
      sessionID: Session.ID,
      inboxID: Option.Option<SessionMessage.ID>,
      turn: Turn,
      since: number,
      ready: Deferred.Deferred<void>,
    ) => {
      const key = `${conversation.remote.name}/${sessionID}`

      const change = (delta: number) =>
        Ref.update(watching, (all) => HashMap.set(all, key, Option.getOrElse(HashMap.get(all, key), () => 0) + delta))

      return change(1).pipe(
        Effect.andThen(watchTurn(conversation, sessionID, inboxID, turn, since, ready)),
        Effect.ensuring(change(-1)),
      )
    }

    // A turn that Wendell did not start has no prepared conversation after a restart, so it is rebuilt from the session.
    const foreignConversation = Effect.fn("Conversations.foreignConversation")(function* (
      remote: Fleet.Remote,
      sessionID: Session.ID,
      channelId: ChannelId,
    ) {
      const known = HashMap.get(yield* Ref.get(prepared), `${remote.name}/${sessionID}`)

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

      if (Option.getOrElse(HashMap.get(yield* Ref.get(watching), `${remote.name}/${sessionID}`), () => 0) > 0) return

      const conversation = yield* foreignConversation(remote, sessionID, channelId.value)
      const since = yield* Clock.currentTimeMillis
      const ready = yield* Deferred.make<void>()

      yield* Effect.logInfo("Watching a turn that Wendell did not start", { server: remote.name, channelId: channelId.value })
      yield* watched(conversation, sessionID, Option.none(), { expectReply: false, progress: false, trigger: Option.none() }, since, ready).pipe(
        Effect.catch((cause) => Effect.logWarning("Turn watcher failed", { server: remote.name, channelId: channelId.value, cause })),
        Effect.forkIn(scope),
      )
    })

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
      (remote) => Effect.all([attachKnown(remote), watchForeign(remote)], { concurrency: 2, discard: true }).pipe(Effect.forkIn(scope)),
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
        const sessionID = yield* ensure(conversation)
        const inboxID = SessionMessage.ID.create()
        const since = yield* Clock.currentTimeMillis
        const ready = yield* Deferred.make<void>()

        yield* Ref.update(ours, HashSet.add(inboxID))
        yield* watched(conversation, sessionID, Option.some(inboxID), turn, since, ready).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Turn watcher failed", { server: conversation.remote.name, channelId: conversation.channelId, cause }),
          ),
          Effect.forkIn(scope),
        )
        yield* Deferred.await(ready).pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore)
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

    const forSession = Effect.fn("Conversations.forSession")(function* (server: string, sessionID: string) {
      return HashMap.get(yield* Ref.get(prepared), `${server}/${sessionID}`)
    })

    const setModel = Effect.fn("Conversations.setModel")(
      function* (conversation: Conversation, model: Models.Resolved) {
        yield* models.setConversation(conversation.remote, conversation.channelId, model.id)

        if (!(yield* exists(conversation))) return

        yield* conversation.remote.client.session.switchModel({
          sessionID: SessionKey.forChannel(conversation.channelId),
          model: model.ref,
        })
        yield* Effect.logInfo("Switched model", {
          server: conversation.remote.name,
          channelId: conversation.channelId,
          model: model.id,
        })
      },
      (effect, conversation) => conversationError("Conversations.setModel", conversation)(effect),
    )

    const currentModel = Effect.fn("Conversations.currentModel")(
      function* (conversation: Conversation) {
        const session = yield* conversation.remote.client.session
          .get({ sessionID: SessionKey.forChannel(conversation.channelId) })
          .pipe(
            Effect.map(Option.some),
            Effect.catchTag("SessionNotFoundError", () => Effect.succeed(Option.none<Session.Info>())),
          )

        const live = Option.flatMap(session, (info) => Option.fromUndefinedOr(info.model)).pipe(Option.map(formatModel))

        return Option.isSome(live) ? live : yield* models.chosen(conversation.remote, conversation.channelId)
      },
      (effect, conversation) => conversationError("Conversations.currentModel", conversation)(effect),
    )

    return Service.of({ exists, deliver, forSession, rootOf, setModel, currentModel })
  }),
)

export * as Conversations from "./Conversations.ts"
