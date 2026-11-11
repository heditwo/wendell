import type { Permission } from "@opencode/client/effect"
import { Duration, Effect, HashMap, Layer, Option, Ref, Schedule, Stream } from "effect"
import { Access } from "./Access.ts"
import { Conversations } from "./Conversations.ts"
import { Discord } from "./Discord.ts"
import { Fleet } from "./Fleet.ts"
import type { ChannelId } from "./Ids.ts"
import { Policy } from "./Policy.ts"
import { SessionKey } from "./SessionKey.ts"

const PREFIX = "wendell:perm:"
const GUARD_RESTART = Duration.seconds(5)
const MAX_RESOURCE = 300

interface Pending {
  readonly remote: Fleet.Remote
  readonly sessionID: string
  readonly requestID: Permission.ID
  readonly channelId: ChannelId
  readonly summary: string
}

const decisions = {
  once: { reply: "once", verb: "allowed this once" },
  always: { reply: "always", verb: "always allowed this" },
  reject: { reply: "reject", verb: "denied this" },
} as const satisfies Record<string, { readonly reply: Permission.Reply; readonly verb: string }>

type Decision = keyof typeof decisions

const isDecision = (value: string): value is Decision => value in decisions

/** `wendell:perm:<key>:<decision>` → key and decision. */
export const parseButton = (customId: string): Option.Option<{ readonly key: string; readonly decision: Decision }> => {
  if (!customId.startsWith(PREFIX)) return Option.none()

  const [key, decision] = customId.slice(PREFIX.length).split(":")

  return key !== undefined && key !== "" && decision !== undefined && isDecision(decision)
    ? Option.some({ key, decision })
    : Option.none()
}

export const describeRequest = (action: string, resources: ReadonlyArray<string>) => {
  const detail = resources.filter((resource) => resource !== "*").join(", ")

  return detail === "" ? `**${action}**` : `**${action}**: \`${detail.slice(0, MAX_RESOURCE).replaceAll("`", "'")}\``
}

/**
 * Answers permission requests from Wendell's sessions. Trusted conversations get
 * Discord buttons that only trusted people can press; everything else is rejected.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fleet = yield* Fleet.Service
    const discord = yield* Discord.Service
    const access = yield* Access.Service
    const conversations = yield* Conversations.Service
    const pending = yield* Ref.make(HashMap.empty<string, Pending>())

    const reject = (remote: Fleet.Remote, sessionID: string, requestID: Permission.ID, action: string) =>
      remote.client.permission
        .reply({
          sessionID: SessionKey.forSessionID(sessionID),
          requestID,
          decision: "reject",
          message: Policy.rejection(action),
        })
        .pipe(Effect.tap(() => Effect.logInfo("Rejected permission request", { server: remote.name, action })))

    const ask = Effect.fn("Approvals.ask")(function* (
      remote: Fleet.Remote,
      channelId: ChannelId,
      sessionID: string,
      requestID: Permission.ID,
      summary: string,
    ) {
      const key = crypto.randomUUID().slice(0, 12)

      yield* Ref.update(pending, HashMap.set(key, { remote, sessionID, requestID, channelId, summary }))
      yield* discord.send(channelId, `I'd like to use ${summary}`, Option.none(), [
        { id: `${PREFIX}${key}:once`, label: "Allow once", style: "success" },
        { id: `${PREFIX}${key}:always`, label: "Always allow", style: "primary" },
        { id: `${PREFIX}${key}:reject`, label: "Deny", style: "danger" },
      ])
    })

    const guard = (remote: Fleet.Remote) =>
      remote.client.event.subscribe({ types: ["permission.asked"] }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type !== "permission.asked") return

            const { sessionID, id, action, resources } = event.data

            if (Option.isNone(SessionKey.channelOf(sessionID))) return

            const conversation = yield* conversations.forSession(remote.name, sessionID)

            if (Option.isNone(conversation) || conversation.value.tier !== "trusted") {
              return yield* reject(remote, sessionID, id, action)
            }

            yield* ask(remote, conversation.value.channelId, sessionID, id, describeRequest(action, resources))
          }).pipe(Effect.catch((cause) => Effect.logWarning("Could not handle a permission request", { cause }))),
        ),
        Effect.catch((cause) => Effect.logWarning("Permission guard stopped", { server: remote.name, cause })),
        Effect.repeat(Schedule.spaced(GUARD_RESTART)),
      )

    const press = Effect.fn("Approvals.press")(function* (event: Discord.ButtonPress) {
      const parsed = parseButton(event.customId)

      if (Option.isNone(parsed)) return

      const { key, decision } = parsed.value
      const request = HashMap.get(yield* Ref.get(pending), key)

      if (Option.isNone(request)) {
        return yield* discord.answerPress(event, "This request is no longer pending.")
      }

      if (!(yield* access.trusted(event.member))) {
        return yield* discord.answerPressPrivately(event, "Only people with access to Wendell's tools can answer this.")
      }

      const { remote, sessionID, requestID, summary } = request.value

      yield* remote.client.permission
        .reply({ sessionID: SessionKey.forSessionID(sessionID), requestID, decision: decisions[decision].reply })
        .pipe(
          Effect.andThen(discord.answerPress(event, `<@${event.member.userId}> ${decisions[decision].verb}: ${summary}`)),
          Effect.catch(() => discord.answerPress(event, "This request is no longer pending.")),
        )
      yield* Ref.update(pending, HashMap.remove(key))
    })

    yield* Effect.forEach(fleet.remotes, (remote) => guard(remote).pipe(Effect.forkScoped), { discard: true })
    yield* discord.buttonPresses.pipe(
      Stream.runForEach((event) =>
        press(event).pipe(Effect.catch((cause) => Effect.logWarning("Could not handle a button press", { cause }))),
      ),
      Effect.forkScoped,
    )
  }),
)

export * as Approvals from "./Approvals.ts"
