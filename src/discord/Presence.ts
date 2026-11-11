import { type Option, Schema } from "effect"

export const Status = Schema.Literals(["online", "idle", "dnd", "invisible"])

export type Status = typeof Status.Type

export const ActivityType = Schema.Literals(["playing", "listening", "watching", "competing", "custom"])

export type ActivityType = typeof ActivityType.Type

export interface Activity {
  readonly type: ActivityType
  readonly text: string
}

/** Wendell's online status and what his profile shows. */
export interface Presence {
  readonly status: Status
  readonly activity: Option.Option<Activity>
}

export * as Presence from "./Presence.ts"
