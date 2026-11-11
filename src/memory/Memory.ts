import { Clock, Context, Effect, HashMap, Layer, Option, Ref, Schema, Semaphore } from "effect"
import path from "node:path"
import { Settings } from "../config/Settings.ts"
import { ChannelId, GuildId, MessageId, UserId } from "../shared/Ids.ts"
import { JsonStore } from "../shared/JsonStore.ts"

/** A scope holds at most this many notes and characters, like a person's working knowledge of someone. */
export const MAX_NOTES = 40
export const MAX_CHARS = 4_000
export const MAX_NOTE_CHARS = 300

export const Note = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  /** Learned in a DM: recalled only in DMs with that person. */
  private: Schema.Boolean,
  source: Schema.Struct({
    guildId: Schema.optional(GuildId),
    channelId: ChannelId,
    messageId: Schema.optional(MessageId),
  }),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  expiresAt: Schema.optional(Schema.Number),
})

export interface Note extends Schema.Schema.Type<typeof Note> {}

const StoredFile = Schema.Struct({
  people: Schema.Record(Schema.String, Schema.Array(Note)).check(Schema.isPropertyNames(UserId)),
  servers: Schema.Record(Schema.String, Schema.Array(Note)).check(Schema.isPropertyNames(GuildId)),
})

interface StoredFile extends Schema.Schema.Type<typeof StoredFile> {}

export type Scope = { readonly about: "person"; readonly userId: UserId } | { readonly about: "server"; readonly guildId: GuildId }

/** Where Wendell is when he reads or writes memory. */
export interface Place {
  readonly guildId: Option.Option<GuildId>
  readonly channelId: ChannelId
}

export interface Change {
  readonly scope: Scope
  readonly text: string
  readonly replaces: Option.Option<string>
  readonly expiresAt: Option.Option<number>
  readonly messageId: Option.Option<MessageId>
}

export class MemoryFull extends Schema.TaggedError<MemoryFull>()("Memory.MemoryFull", {
  message: Schema.String,
}) {}

export class NoteNotFound extends Schema.TaggedError<NoteNotFound>()("Memory.NoteNotFound", {
  id: Schema.String,
}) {}

export interface Interface {
  /** The notes that may be recalled here: no expired notes, and DM notes only in DMs. */
  readonly recall: (scope: Scope, place: Place) => Effect.Effect<ReadonlyArray<Note>>
  readonly remember: (change: Change, place: Place) => Effect.Effect<Note, MemoryFull | NoteNotFound | JsonStore.StoreError>
  /** Removes a note from the scopes that are visible here. Returns the removed note. */
  readonly forget: (id: string, visible: ReadonlyArray<Scope>, place: Place) => Effect.Effect<Note, NoteNotFound | JsonStore.StoreError>
  /** Every person, plus this server: what the agent may change from here. */
  readonly allScopes: (place: Place) => Effect.Effect<ReadonlyArray<Scope>>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Memory") {}

const isDirect = (place: Place) => Option.isNone(place.guildId)

/** DM notes stay in DMs, so nothing said in private reaches a server. */
export const visibleIn = (note: Note, place: Place, now: number) =>
  (note.expiresAt === undefined || note.expiresAt > now) && (!note.private || isDirect(place))

const notesOf = (file: StoredFile, scope: Scope) =>
  scope.about === "person" ? (file.people[scope.userId] ?? []) : (file.servers[scope.guildId] ?? [])

const withNotes = (file: StoredFile, scope: Scope, notes: ReadonlyArray<Note>): StoredFile =>
  scope.about === "person"
    ? { ...file, people: { ...file.people, [scope.userId]: notes } }
    : { ...file, servers: { ...file.servers, [scope.guildId]: notes } }

const size = (notes: ReadonlyArray<Note>) => notes.reduce((total, note) => total + note.text.length, 0)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const store = yield* JsonStore.make(StoredFile, path.join(settings.dataDirectory, "memory.json"), { people: {}, servers: {} })
    const initial = yield* store.get
    const known = Object.values(initial.people).concat(Object.values(initial.servers)).flat()
    const ids = yield* Ref.make(HashMap.fromIterable(known.map((note) => [note.id, true] as const)))
    // One change at a time: each checks the limits against the notes as they are.
    const writes = yield* Semaphore.make(1)

    const newId = Effect.gen(function* () {
      for (;;) {
        const id = `m_${crypto.randomUUID().slice(0, 6)}`

        if (!HashMap.has(yield* Ref.get(ids), id)) {
          yield* Ref.update(ids, HashMap.set(id, true))

          return id
        }
      }
    })

    const recall = Effect.fn("Memory.recall")(function* (scope: Scope, place: Place) {
      const now = yield* Clock.currentTimeMillis

      return notesOf(yield* store.get, scope).filter((note) => visibleIn(note, place, now))
    })

    const remember = Effect.fn("Memory.remember")(
      function* (change: Change, place: Place) {
        const now = yield* Clock.currentTimeMillis
        const current = yield* store.get
        const live = notesOf(current, change.scope).filter((note) => note.expiresAt === undefined || note.expiresAt > now)

        const replaced = Option.map(change.replaces, (id) => live.find((note) => note.id === id && visibleIn(note, place, now)))

        if (Option.isSome(change.replaces) && Option.getOrUndefined(replaced) === undefined) {
          return yield* new NoteNotFound({ id: change.replaces.value })
        }

        const old = Option.getOrUndefined(Option.flatMap(replaced, Option.fromUndefinedOr))
        const rest = live.filter((note) => note.id !== old?.id)

        const note: Note = {
          id: old?.id ?? (yield* newId),
          text: change.text.trim().slice(0, MAX_NOTE_CHARS),
          // A DM note stays private, and a note moved into a DM conversation becomes private.
          private: isDirect(place) || old?.private === true,
          source: {
            guildId: Option.getOrUndefined(place.guildId),
            channelId: place.channelId,
            messageId: Option.getOrUndefined(change.messageId),
          },
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
          expiresAt: Option.getOrUndefined(change.expiresAt),
        }

        const next = [...rest, note]

        if (next.length > MAX_NOTES || size(next) > MAX_CHARS) {
          return yield* new MemoryFull({
            message:
              `Memory is full (${MAX_NOTES} notes or ${MAX_CHARS} characters). ` +
              "Merge related notes with replaces, or forget notes that no longer matter, then try again.",
          })
        }

        yield* store.update((latest) => withNotes(latest, change.scope, next))

        return note
      },
      (effect) => Semaphore.withPermits(writes, 1)(effect),
    )

    const forget = Effect.fn("Memory.forget")(
      function* (id: string, visible: ReadonlyArray<Scope>, place: Place) {
        const now = yield* Clock.currentTimeMillis
        const current = yield* store.get

        for (const scope of visible) {
          const notes = notesOf(current, scope)
          const found = notes.find((note) => note.id === id && visibleIn(note, place, now))

          if (found !== undefined) {
            yield* store.update((latest) => withNotes(latest, scope, notes.filter((note) => note.id !== id)))

            return found
          }
        }

        return yield* new NoteNotFound({ id })
      },
      (effect) => Semaphore.withPermits(writes, 1)(effect),
    )

    const allScopes = Effect.fn("Memory.allScopes")(function* (place: Place) {
      const current = yield* store.get

      return [
        ...Object.keys(current.people).map((userId): Scope => ({ about: "person", userId: UserId.make(userId) })),
        ...Option.toArray(place.guildId).map((guildId): Scope => ({ about: "server", guildId })),
      ]
    })

    return Service.of({ recall, remember, forget, allScopes })
  }),
)

export * as Memory from "./Memory.ts"
