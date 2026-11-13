import { Context, Effect, HashMap, Layer, Option, Ref, Schema } from "effect"
import { Discord } from "../discord/Discord.ts"
import type { Embeds } from "../discord/Embeds.ts"
import type { Inbound } from "../inbound/Inbound.ts"
import { Recent } from "../inbound/Recent.ts"
import type { Fleet } from "../opencode/Fleet.ts"
import type { ChannelId, MessageId, ServerName, UserId } from "../shared/Ids.ts"
import { Calls } from "../voice/Calls.ts"
import { Speech } from "../voice/Speech.ts"
import { Activity } from "./Activity.ts"
import { Source } from "./Conversation.ts"

const NOT_IN_CALL = "You are not in a voice call that this conversation can speak in."

// A turn ends and removes its source. The cap only bounds the state when a turn never ends.
const MAX_SOURCES = 16

/**
 * One delivered prompt of a running turn. A reply answers everything that was delivered before it, so a later
 * reply answers only the prompts that came after: those that no reply has answered yet. When there are none
 * (for example a second progress update), it answers all of them again.
 */
interface Running {
  readonly turnKey: string
  readonly source: Source
  readonly answered: boolean
}

export interface Reply {
  readonly text: string
  readonly replyTo: Option.Option<MessageId>
  readonly files: ReadonlyArray<Discord.Upload>
  readonly embeds: ReadonlyArray<Embeds.Embed>
  readonly mention: Option.Option<UserId>
  /** True: also say it in the voice call. False: do not say it. None: decide from the inputs of the running turns. */
  readonly speak: Option.Option<boolean>
  /** Post the text also when the people that it answers heard it in the call. */
  readonly post: boolean
}

export interface Sent {
  readonly spoken: boolean
  /** None when the reply was only spoken. */
  readonly posted: Option.Option<{ readonly channelId: ChannelId; readonly messageId: MessageId }>
  /** The reply was spoken, and the text post that it also needed failed. */
  readonly postFailed: boolean
}

/** The message goes back to the agent. */
export class ReplyError extends Schema.TaggedError<ReplyError>()("Replies.ReplyError", {
  message: Schema.String,
}) {}

export interface Interface {
  /** Records where one delivered prompt came from. `turnKey` names the watcher of that prompt. */
  readonly arrived: (server: ServerName, channelId: ChannelId, turnKey: string, source: Source) => Effect.Effect<void>
  /** Forgets the source of a prompt whose turn ended. The other running prompts of the conversation keep theirs. */
  readonly ended: (server: ServerName, channelId: ChannelId, turnKey: string) => Effect.Effect<void>
  /**
   * Sends Wendell's reply for the conversation of `channelId`. A reply that the people it answers heard in the
   * voice call is not posted as text, unless `post` is set or it has parts that speech cannot carry.
   */
  readonly send: (remote: Fleet.Remote, channelId: ChannelId, reply: Reply) => Effect.Effect<Sent, ReplyError>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Replies") {}

const keyOf = (server: ServerName, channelId: ChannelId) => `${server}/${channelId}`

// Wendell's own input adds no people, so it counts only when nothing else is running.
const sourcesToAnswer = (running: ReadonlyArray<Source>): ReadonlyArray<Source> => {
  const fromPeople = running.filter((source) => !Source.$is("Own")(source))

  return fromPeople.length > 0 ? fromPeople : [Source.Own()]
}

export const layer: Layer.Layer<Service, never, Discord.Service | Activity.Service | Calls.Service | Recent.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discord = yield* Discord.Service
    const activity = yield* Activity.Service
    const calls = yield* Calls.Service
    const recent = yield* Recent.Service
    const running = yield* Ref.make(HashMap.empty<string, ReadonlyArray<Running>>())

    const arrived = Effect.fn("Replies.arrived")(function* (server: ServerName, channelId: ChannelId, turnKey: string, source: Source) {
      const key = keyOf(server, channelId)

      yield* Ref.update(running, (all) => {
        const others = Option.getOrElse(HashMap.get(all, key), () => []).filter((entry) => entry.turnKey !== turnKey)

        return HashMap.set(all, key, [...others, { turnKey, source, answered: false }].slice(-MAX_SOURCES))
      })
    })

    const ended = Effect.fn("Replies.ended")(function* (server: ServerName, channelId: ChannelId, turnKey: string) {
      const key = keyOf(server, channelId)

      yield* Ref.update(running, (all) => {
        const left = Option.getOrElse(HashMap.get(all, key), () => []).filter((entry) => entry.turnKey !== turnKey)

        return left.length === 0 ? HashMap.remove(all, key) : HashMap.set(all, key, left)
      })
    })

    const markAnswered = Effect.fn("Replies.markAnswered")(function* (key: string, turnKeys: ReadonlyArray<string>) {
      yield* Ref.update(running, (all) =>
        Option.match(HashMap.get(all, key), {
          onNone: () => all,
          onSome: (entries) =>
            HashMap.set(
              all,
              key,
              entries.map((entry) => (turnKeys.includes(entry.turnKey) ? { ...entry, answered: true } : entry)),
            ),
        }),
      )
    })

    const callWith = Effect.fn("Replies.callWith")(function* (userId: UserId) {
      const found = yield* Effect.filter(yield* calls.all, (call) =>
        calls.people(call).pipe(Effect.map((people) => people.some((person) => person.userId === userId))),
      )

      return Option.fromUndefinedOr(found[0])
    })

    // A conversation without a call can speak in the call of its server, or in the call of the person of its DM.
    const callElsewhere = Effect.fn("Replies.callElsewhere")(function* (channelId: ChannelId) {
      const info = yield* discord.channel(channelId).pipe(Effect.option)

      if (Option.isNone(info)) return Option.none<Calls.Call>()

      return yield* Option.match(info.value.guildId, {
        onSome: calls.inGuild,
        onNone: () =>
          Option.match(info.value.recipient, {
            onNone: () => Effect.succeed(Option.none<Calls.Call>()),
            onSome: ({ userId }) => callWith(userId),
          }),
      })
    })

    const deliver = Effect.fn("Replies.deliver")(function* (
      remote: Fleet.Remote,
      channelId: ChannelId,
      reply: Reply,
      entries: ReadonlyArray<Running>,
    ) {
      const home = yield* calls.ofHome(remote.name, channelId)
      const people = Option.isSome(home) ? yield* calls.people(home.value) : []
      const present = (userId: UserId) => people.some((person) => person.userId === userId)

      const replied = yield* Option.match(reply.replyTo, {
        onNone: () => Effect.succeed(Option.none<Inbound.Message>()),
        onSome: recent.get,
      })

      const unanswered = entries.filter((entry) => !entry.answered)
      const candidates = (unanswered.length > 0 ? unanswered : entries).map((entry) => entry.source)

      const answering: ReadonlyArray<Source> = Option.match(replied, {
        onNone: () => sourcesToAnswer(candidates),
        onSome: (message) => [Source.Chat({ channelId: message.channelId, authors: [message.authorId] })],
      })

      const voiceChat = Option.map(home, (call) => call.channelId)

      const answersPerson = answering.some((source) =>
        Source.$match(source, {
          Chat: ({ authors }) => authors.some(present),
          Speech: () => true,
          Own: () => false,
        }),
      )

      const speak = Option.getOrElse(reply.speak, () => Option.isSome(home) && (answersPerson || Option.exists(reply.mention, present)))

      const target = !speak
        ? Option.none<{ readonly call: Calls.Call; readonly from: Option.Option<ChannelId> }>()
        : Option.isSome(home)
          ? Option.some({ call: home.value, from: Option.none<ChannelId>() })
          : Option.map(yield* callElsewhere(channelId), (call) => ({ call, from: Option.some(channelId) }))

      if (speak && Option.isNone(target)) return yield* new ReplyError({ message: NOT_IN_CALL })

      const spoken = yield* Option.match(target, {
        onNone: () => Effect.succeed(false),
        onSome: ({ call, from }) => calls.say(call, reply.text, from),
      })

      const listeners = yield* Option.match(target, {
        onNone: () => Effect.succeed<ReadonlyArray<Discord.VoiceMember>>([]),
        onSome: ({ call, from }) => (Option.isNone(from) ? Effect.succeed(people) : calls.people(call)),
      })

      const heard = (userId: UserId) => listeners.some((person) => person.userId === userId)

      // The people that the reply answers are all in the call, so they heard it.
      const heardByAsker = answering.every((source) =>
        Source.$match(source, {
          Chat: ({ authors }) => authors.length > 0 && authors.every(heard),
          Speech: () => true,
          Own: () => Option.exists(target, ({ from }) => Option.isNone(from)),
        }),
      )

      // The post must reach the people who typed and did not hear the reply.
      const chats = answering.flatMap((source) => (Source.$is("Chat")(source) ? [source] : [])).reverse()
      const chatToReach = chats.find(({ authors }) => authors.some((userId) => !heard(userId))) ?? chats[0]

      const textChannel =
        chatToReach !== undefined && (chatToReach.channelId === channelId || Option.contains(voiceChat, chatToReach.channelId))
          ? chatToReach.channelId
          : channelId

      // Files, embeds, links and code cannot be spoken, and a ping needs a message.
      const needsText =
        reply.post ||
        reply.files.length > 0 ||
        reply.embeds.length > 0 ||
        Option.isSome(reply.mention) ||
        Speech.hasUnspokenParts(reply.text)

      if (spoken && heardByAsker && !needsText) {
        yield* activity.spoke(channelId)
        yield* Effect.logInfo("Sent a reply", { server: remote.name, channelId, spoken, postedIn: undefined })

        return { spoken, posted: Option.none(), postFailed: false } satisfies Sent
      }

      const content = Option.match(reply.mention, {
        onNone: () => reply.text,
        onSome: (userId) => (reply.text.includes(`<@${userId}>`) ? reply.text : `<@${userId}> ${reply.text}`),
      })

      const replyTo = Option.match(replied, {
        onNone: () => (textChannel === channelId ? reply.replyTo : Option.none()),
        onSome: (message) => (message.channelId === textChannel ? reply.replyTo : Option.none()),
      })

      const messageId = yield* discord
        .post(textChannel, { text: content, replyTo, files: reply.files, embeds: reply.embeds, mention: reply.mention })
        .pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            Effect.logWarning("Could not post a reply", { channelId: textChannel, spoken, cause: error.cause }).pipe(
              Effect.as(Option.none<MessageId>()),
            ),
          ),
        )

      if (Option.isNone(messageId) && !spoken) {
        return yield* new ReplyError({
          message:
            reply.files.length === 0
              ? "Could not post the message."
              : "Could not post the message. The files may be too large for this Discord server.",
        })
      }

      yield* activity.spoke(channelId)

      if (textChannel !== channelId && Option.isSome(messageId)) yield* activity.spoke(textChannel)

      yield* Effect.logInfo("Sent a reply", {
        server: remote.name,
        channelId,
        spoken,
        postedIn: Option.isSome(messageId) ? textChannel : undefined,
      })

      return {
        spoken,
        posted: Option.map(messageId, (id) => ({ channelId: textChannel, messageId: id })),
        postFailed: Option.isNone(messageId),
      } satisfies Sent
    })

    const send = Effect.fn("Replies.send")(function* (remote: Fleet.Remote, channelId: ChannelId, reply: Reply) {
      const key = keyOf(remote.name, channelId)
      const entries = Option.getOrElse(HashMap.get(yield* Ref.get(running), key), () => [])
      const sent = yield* deliver(remote, channelId, reply, entries)

      yield* markAnswered(key, entries.map((entry) => entry.turnKey))

      return sent
    })

    return Service.of({ arrived, ended, send })
  }),
)

export * as Replies from "./Replies.ts"
