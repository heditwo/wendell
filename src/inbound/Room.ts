import type { AbsolutePath } from "@opencode/client/effect"
import { Clock, Context, Duration, Effect, HashMap, Layer, Option, Ref } from "effect"
import type { Conversation } from "../conversations/Conversation.ts"
import type { ChannelId } from "../shared/Ids.ts"
import { attribute, escape } from "../shared/Text.ts"
import { Attachments } from "./Attachments.ts"
import { Inbound } from "./Inbound.ts"

const ROOM_MESSAGES = 8
const ROOM_WINDOW = Duration.minutes(15)
const ROOM_MESSAGE_CHARS = 400
const MAX_FILES = 8

export interface Interface {
  /** A message that Wendell did not get, kept as room context for his next turn in that channel. */
  readonly overheard: (message: Inbound.Message) => Effect.Effect<void>
  /**
   * The messages overheard in the conversation's channel since its last turn, as a `<room_context>` block.
   * Their newest files are saved in the conversation's directory, and their images go to the model with the prompt.
   */
  readonly take: (conversation: Conversation) => Effect.Effect<Overheard>
}

export interface Overheard {
  readonly blocks: ReadonlyArray<string>
  readonly images: ReadonlyArray<AbsolutePath>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Room") {}

interface Entry {
  readonly at: number
  readonly message: Inbound.Message
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const attachments = yield* Attachments.Service
    const room = yield* Ref.make(HashMap.empty<ChannelId, ReadonlyArray<Entry>>())

    const overheard = Effect.fn("Room.overheard")(function* (message: Inbound.Message) {
      if (Inbound.plainText(message).trim() === "") return

      const at = yield* Clock.currentTimeMillis

      yield* Ref.update(room, (all) =>
        HashMap.set(
          all,
          message.channelId,
          [...Option.getOrElse(HashMap.get(all, message.channelId), () => []), { at, message }].slice(-ROOM_MESSAGES),
        ),
      )
    })

    // People talk about the screenshots they just posted, so the newest files are saved and the older ones only named.
    const files = Effect.fn("Room.files")(function* (conversation: Conversation, entries: ReadonlyArray<Entry>) {
      const notes = new Map<string, ReadonlyArray<Inbound.FileNote>>()
      let budget = MAX_FILES

      for (const { message } of entries.toReversed()) {
        if (message.attachments.length === 0) continue

        const kept = message.attachments.slice(0, Math.max(0, budget))

        const skipped = message.attachments.slice(kept.length).map((attachment) =>
          Inbound.FileNote.Skipped({ name: attachment.name, size: attachment.size, reason: "older file, not downloaded" }),
        )

        budget -= kept.length

        const saved = kept.length === 0 ? [] : yield* attachments.save(conversation.remote, conversation.directory, { ...message, attachments: kept })

        notes.set(message.id, [...saved, ...skipped])
      }

      return notes
    })

    const take = Effect.fn("Room.take")(function* (conversation: Conversation) {
      const now = yield* Clock.currentTimeMillis

      const entries = yield* Ref.modify(room, (all) => [
        Option.getOrElse(HashMap.get(all, conversation.channelId), () => []).filter(({ at }) => now - at <= Duration.toMillis(ROOM_WINDOW)),
        HashMap.remove(all, conversation.channelId),
      ])

      if (entries.length === 0) return { blocks: [], images: [] } satisfies Overheard

      const notes = yield* files(conversation, entries)

      const lines = entries.map(({ message }) => {
        const text = Inbound.plainText({ ...message, attachments: [] }).slice(0, ROOM_MESSAGE_CHARS)

        return [`${attribute(message.authorName)}: ${escape(text)}`.trimEnd(), ...(notes.get(message.id) ?? []).map(Inbound.renderFile)].join(
          "\n",
        )
      })

      return {
        blocks: [
          '<room_context note="Messages in this channel since your last turn that were not for you, oldest first. Context only; do not answer them.">\n' +
            `${lines.join("\n")}\n</room_context>`,
        ],
        images: entries.flatMap(({ message }) => Attachments.images(notes.get(message.id) ?? [])),
      } satisfies Overheard
    })

    return Service.of({ overheard, take })
  }),
)

export * as Room from "./Room.ts"
