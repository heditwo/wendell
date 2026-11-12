import { Agent, type Model, type Session } from "@opencode/client/effect"
import { Effect, FileSystem, HashMap, Option, Ref } from "effect"
import { Settings } from "../config/Settings.ts"
import { WendellConfig } from "../config/WendellConfig.ts"
import { Fleet } from "../opencode/Fleet.ts"
import { Models } from "../opencode/Models.ts"
import { Policy } from "../opencode/Policy.ts"
import { SessionKey } from "../opencode/SessionKey.ts"
import { Briefing } from "./Briefing.ts"
import { type Conversation, conversationError } from "./Conversation.ts"

const PERSONA_KEY = "wendell"
const CONTEXT_KEY = "wendell-conversation"
const MAX_SESSION_DEPTH = 8

export const formatModel = (model: Model.Ref) =>
  `${model.providerID}/${model.id}${model.variant === undefined || model.variant === "default" ? "" : `#${model.variant}`}`

/** `server/sessionID`: a session ID is unique only on its server. */
export const keyOf = (server: string, sessionID: string) => `${server}/${sessionID}`

/** The session of each conversation: creation, permissions, persona, context entry and model. */
export const make = Effect.gen(function* () {
  const settings = yield* Settings.Service
  const fs = yield* FileSystem.FileSystem
  const fleet = yield* Fleet.Service
  const models = yield* Models.Service
  const config = yield* WendellConfig.Service
  const contextFor = yield* Briefing.make
  const persona = yield* fs.readFileString(settings.personaFile).pipe(Effect.orDie)
  const prepared = yield* Ref.make(HashMap.empty<string, Conversation>())
  const contexts = yield* Ref.make(HashMap.empty<string, string>())
  const roots = yield* Ref.make(HashMap.empty<string, Option.Option<string>>())

  const rootOf = Effect.fn("Conversations.rootOf")(function* (remote: Fleet.Remote, sessionID: string) {
    const cacheKey = keyOf(remote.name, sessionID)
    const cached = HashMap.get(yield* Ref.get(roots), cacheKey)

    if (Option.isSome(cached)) return cached.value

    let current = Option.some(sessionID)

    for (let depth = 0; depth < MAX_SESSION_DEPTH && Option.isSome(current); depth += 1) {
      if (Option.isSome(SessionKey.channelOf(current.value))) break

      const info = yield* remote.client.session.get({ sessionID: SessionKey.forSessionID(current.value) }).pipe(Effect.option)

      current = Option.flatMap(info, (session) => Option.fromNullishOr(session.parentID))
    }

    const root = Option.filter(current, (id) => Option.isSome(SessionKey.channelOf(id)))

    yield* Ref.update(roots, HashMap.set(cacheKey, root))

    return root
  })

  const forSession = Effect.fn("Conversations.forSession")(function* (server: string, sessionID: string) {
    return HashMap.get(yield* Ref.get(prepared), keyOf(server, sessionID))
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
      Effect.tapErrorTag("Models.NoAllowedModel", (error) => Effect.logError(error.message, { channelId: conversation.channelId })),
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
    const key = keyOf(conversation.remote.name, sessionID)
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

  return { rootOf, forSession, exists, ensure, setModel, currentModel }
})

export type Interface = Effect.Success<typeof make>

export * as Sessions from "./Sessions.ts"
