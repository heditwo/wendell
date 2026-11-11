import type { OpenCodeClient } from "@opencode/client/effect"
import { DateTime, Effect, Option } from "effect"
import { Places } from "../../conversations/Places.ts"
import { SessionKey } from "../../opencode/SessionKey.ts"
import { truncate } from "../../shared/Text.ts"
import type { Discord } from "../Discord.ts"
import { Command } from "./Command.ts"

type ScheduleInfo = Effect.Success<ReturnType<OpenCodeClient["experimental"]["schedule"]["list"]>>[number]

const MAX_LABEL = 60

const labelOf = (schedule: ScheduleInfo) => truncate(schedule.name ?? schedule.action.prompt, MAX_LABEL)

const whenOf = (schedule: ScheduleInfo) => {
  const { when } = schedule

  if (when.type === "in") return `once, ${when.in} after it was made`

  if (when.type === "at") return `once at ${when.at} (${schedule.tz})`

  if (when.type === "every") return `every ${when.every}`

  return `cron \`${when.cron}\` (${schedule.tz})`
}

const nextOf = (schedule: ScheduleInfo) => {
  if (schedule.status === "paused") return "paused"

  if (schedule.nextDueAt === undefined) return "no next run"

  const seconds = Math.round(DateTime.toEpochMillis(schedule.nextDueAt) / 1000)

  return `next <t:${seconds}:f> (<t:${seconds}:R>)`
}

const describeSchedule = (schedule: ScheduleInfo) => `- **${labelOf(schedule)}**: ${whenOf(schedule)}, ${nextOf(schedule)}`

/** `/reminders`: lists the schedules of this conversation's session, or cancels one. */
export const make = Effect.gen(function* () {
  const places = yield* Places.Service

  const schedulesOf = Effect.fn("RemindersCommand.schedulesOf")(function* (call: Discord.CommandCall) {
    const place = yield* places.forOrigin(Command.origin(call))
    const { remote, channelId } = place.conversation

    const all = yield* remote.client.experimental.schedule
      .list({ sessionID: SessionKey.forChannel(channelId) })
      .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed<ReadonlyArray<ScheduleInfo>>([])))

    return { remote, schedules: all.filter((schedule) => schedule.status !== "done") }
  })

  const answer = (call: Discord.CommandCall) =>
    Effect.gen(function* () {
      const { remote, schedules } = yield* schedulesOf(call)
      const cancel = Command.option(call, "cancel")

      if (Option.isSome(cancel)) {
        const wanted = cancel.value.trim()
        const found = schedules.find((schedule) => schedule.id === wanted || schedule.name === wanted)

        if (found === undefined) return "I found no reminder with that name in this conversation."

        yield* remote.client.experimental.schedule.delete({ scheduleID: found.id })
        yield* Effect.logInfo("Cancelled a schedule", { server: remote.name, channelId: call.channelId })

        return `Cancelled **${labelOf(found)}**.`
      }

      if (schedules.length === 0) return "There are no reminders or check-ins in this conversation."

      return ["Reminders and check-ins here:", ...schedules.map(describeSchedule)].join("\n")
    }).pipe(Command.orReply("Could not answer /reminders", "I could not read the reminders. Try again."))

  const autocomplete = (call: Discord.CommandCall, query: string) =>
    Effect.gen(function* () {
      const { schedules } = yield* schedulesOf(call)
      const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "")

      return schedules
        .filter((schedule) => words.every((word) => `${schedule.name ?? ""} ${schedule.action.prompt}`.toLowerCase().includes(word)))
        .map((schedule): Discord.Choice => ({ name: `${labelOf(schedule)} · ${whenOf(schedule)}`, value: schedule.id }))
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not list reminders for autocomplete", { cause }).pipe(Effect.as([]))),
    )

  return {
    spec: {
      name: "reminders",
      description: "Show the reminders and check-ins of this conversation, or cancel one.",
      options: [{ name: "cancel", description: "The reminder to cancel.", required: false, autocomplete: true, choices: [] }],
    },
    ephemeral: () => true,
    answer,
    autocomplete: Option.some(autocomplete),
  } satisfies Command.Command
})

export * as RemindersCommand from "./RemindersCommand.ts"
