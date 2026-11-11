import { AbsolutePath, type Permission } from "@opencode/client/effect"
import { Duration, Effect, HashMap, HashSet, Layer, Option, Ref, Schedule, Stream } from "effect"
import { ApprovalModes } from "../modes/ApprovalModes.ts"
import { Conversations } from "../conversations/Conversations.ts"
import { Discord } from "../discord/Discord.ts"
import { Fleet } from "../opencode/Fleet.ts"
import type { ChannelId } from "../shared/Ids.ts"
import { Policy } from "../opencode/Policy.ts"
import { Reviewer } from "./Reviewer.ts"
import { SessionKey } from "../opencode/SessionKey.ts"
import { Tasks } from "../tasks/Tasks.ts"

const PREFIX = "wendell:perm:"
const GUARD_RESTART = Duration.seconds(5)
const MAX_RESOURCE = 300

const DENIED =
  "A person in Discord denied this request. Do not try it another way. " +
  "Continue without it, or tell them briefly what you need and why."

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

/** Reading `.env` files, directly or in a shell command, always needs a person, whatever the approval mode. */
export const touchesSecrets = (action: string, resources: ReadonlyArray<string>) =>
  (action === "read" && resources.some(Policy.isSecretFile)) ||
  (action === "shell" && resources.some((command) => /\.env\b/.test(command)))

/**
 * Answers permission requests from Wendell's sessions. Depending on the conversation's approval mode,
 * Wendell approves the request, lets the decision model review it, or posts buttons in the conversation.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fleet = yield* Fleet.Service
    const discord = yield* Discord.Service
    const conversations = yield* Conversations.Service
    const approvalModes = yield* ApprovalModes.Service
    const reviewer = yield* Reviewer.Service
    const tasks = yield* Tasks.Service
    const handled = yield* Ref.make(HashSet.empty<string>())
    const noted = yield* Ref.make(HashSet.empty<string>())
    const pending = yield* Ref.make(HashMap.empty<string, Pending>())

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

    const approve = Effect.fn("Approvals.approve")(function* (
      remote: Fleet.Remote,
      channelId: ChannelId,
      sessionID: string,
      requestID: Permission.ID,
      action: string,
      note: string,
    ) {
      yield* remote.client.permission.reply({ sessionID: SessionKey.forSessionID(sessionID), requestID, decision: "once" })
      yield* Effect.logInfo("Approved permission request", { server: remote.name, channelId, action })

      // Routine shell commands already show in the status line, and a repeated note adds nothing.
      if (action === "shell") return

      const key = `${channelId}:${note}`
      const fresh = yield* Ref.modify(noted, (seen) => [!HashSet.has(seen, key), HashSet.add(seen, key)])

      if (fresh) yield* discord.send(channelId, `-# ${note}`, Option.none()).pipe(Effect.ignore)
    })

    const decide = Effect.fn("Approvals.decide")(function* (
      remote: Fleet.Remote,
      channelId: ChannelId,
      sessionID: string,
      requestID: Permission.ID,
      action: string,
      resources: ReadonlyArray<string>,
    ) {
      const summary = describeRequest(action, resources)
      const mode = touchesSecrets(action, resources) ? "off" : yield* approvalModes.modeFor(remote, channelId)

      if (mode === "auto") return yield* approve(remote, channelId, sessionID, requestID, action, `Auto-approved ${summary}`)

      if (mode === "review" && (yield* reviewer.approves({ remote, channelId, action, resources }))) {
        return yield* approve(remote, channelId, sessionID, requestID, action, `Approved after review: ${summary}`)
      }

      yield* ask(remote, channelId, sessionID, requestID, summary)
    })

    const handle = Effect.fn("Approvals.handle")(function* (
      remote: Fleet.Remote,
      request: { readonly sessionID: string; readonly id: Permission.ID; readonly action: string; readonly resources: ReadonlyArray<string> },
    ) {
      const fresh = yield* Ref.modify(handled, (seen) => [!HashSet.has(seen, request.id), HashSet.add(seen, request.id)])

      if (!fresh) return

      const channelId = Option.flatMap(yield* conversations.rootOf(remote, request.sessionID), SessionKey.channelOf)

      if (Option.isNone(channelId)) return

      yield* decide(remote, channelId.value, request.sessionID, request.id, request.action, request.resources)
    })

    // Requests that were asked while Wendell was not listening, for example during a restart.
    const sweep = Effect.fn("Approvals.sweep")(function* (remote: Fleet.Remote) {
      const directories = new Set([
        remote.directory,
        ...(yield* tasks.all).flatMap((task) => (task.server === remote.name ? [task.directory] : [])),
      ])

      yield* Effect.forEach(
        directories,
        (directory) =>
          remote.client.permission.request.list({ location: { directory: AbsolutePath.make(directory) } }).pipe(
            Effect.flatMap((page) => Effect.forEach(page.data, (request) => handle(remote, request), { discard: true })),
            Effect.catch((cause) => Effect.logWarning("Could not list pending permission requests", { directory, cause })),
          ),
        { discard: true },
      )
    })

    const guard = (remote: Fleet.Remote) =>
      remote.client.event.subscribe({ types: ["permission.asked"] }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "server.connected") return yield* sweep(remote)

            if (event.type !== "permission.asked") return

            yield* handle(remote, event.data)
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

      const { remote, sessionID, requestID, summary } = request.value

      yield* remote.client.permission
        .reply({
          sessionID: SessionKey.forSessionID(sessionID),
          requestID,
          decision: decisions[decision].reply,
          // Without a message, OpenCode ends the whole turn on a rejection; with one, the agent continues.
          message: decision === "reject" ? DENIED : undefined,
        })
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
