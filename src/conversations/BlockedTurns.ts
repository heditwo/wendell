import type { OpenCodeClient, Session, SessionMessage } from "@opencode/client/effect"
import { Data, Duration, Effect, Option, Schedule, Schema } from "effect"

/** The error type of a turn that the model's provider stopped with a content filter. */
export const ERROR_TYPE = "provider.content-filter"

const PAGE = 50
const MAX_PAGES = 8
const RETRY_EVERY = Duration.seconds(2)
const RETRIES = 15

export class TurnRunning extends Schema.TaggedError<TurnRunning>()("BlockedTurns.TurnRunning", {}) {}

type Found = Data.TaggedEnum<{
  Running: {}
  Clean: {}
  Blocked: { readonly from: SessionMessage.ID; readonly turns: number }
}>

const Found = Data.taggedEnum<Found>()

const isBlocked = (message: SessionMessage.Idle) => message.outcome === "failed" && message.error?.type === ERROR_TYPE

// Records of a change to the session. They are not part of what a turn said, and one at the end is not a running turn.
const isRecord = (message: SessionMessage.Info) =>
  message.type === "system" || message.type === "agent-switched" || message.type === "model-switched" || message.type === "location-switched"

/**
 * Finds the blocked turns at the end of a session. Each turn ends with an `idle` message, so the turns are read
 * from the newest message back to the first turn that was not blocked. `from` is the oldest prompt, answer or
 * command of these turns: records before it, such as a model change, stay.
 */
const find = Effect.fn("BlockedTurns.find")(function* (client: OpenCodeClient, sessionID: Session.ID) {
  let from = Option.none<SessionMessage.ID>()
  let turns = 0
  let cursor: string | undefined

  const found = () => Option.match(from, { onNone: () => Found.Clean(), onSome: (id) => Found.Blocked({ from: id, turns }) })

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // The server refuses `order` together with a cursor. The cursor keeps the order of the first page.
    const listed = yield* client.message.list(
      cursor === undefined ? { sessionID, order: "desc", limit: PAGE } : { sessionID, cursor, limit: PAGE },
    )

    for (const message of listed.data) {
      if (message.type === "idle") {
        if (!isBlocked(message)) return found()

        turns += 1
      } else if (message.type === "compaction") {
        return found()
      } else if (!isRecord(message)) {
        if (turns === 0) return Found.Running()

        from = Option.some(message.id)
      }
    }

    cursor = listed.cursor.next

    if (cursor === undefined) break
  }

  return found()
})

/**
 * Removes the blocked turns at the end of a session, and returns how many it removed.
 *
 * A provider's filter reads the full context, so a blocked message blocks each later turn until it is gone.
 * The session cannot change while a turn runs, so this waits for the turn to end.
 */
export const remove = Effect.fn("BlockedTurns.remove")(function* (client: OpenCodeClient, sessionID: Session.ID) {
  const attempt = Effect.gen(function* () {
    const found = yield* find(client, sessionID)

    return yield* Found.$match(found, {
      Running: () => Effect.fail(new TurnRunning()),
      Clean: () => Effect.succeed(0),
      Blocked: ({ from, turns }) =>
        Effect.gen(function* () {
          // `files: false` removes only the messages. Files that the turn changed stay as they are.
          yield* client.session.revert.stage({ sessionID, messageID: from, files: false })
          yield* client.session.revert.commit({ sessionID })

          return turns
        }).pipe(Effect.catchTag("SessionBusyError", () => Effect.fail(new TurnRunning()))),
    })
  })

  return yield* attempt.pipe(
    Effect.retry({ schedule: Schedule.spaced(RETRY_EVERY), times: RETRIES, while: (error) => error instanceof TurnRunning }),
  )
})

export * as BlockedTurns from "./BlockedTurns.ts"
