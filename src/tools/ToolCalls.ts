import { Context, Data, Deferred, Effect, Layer, type Option, Queue, Schema, Stream } from "effect"
import type { Embeds } from "../discord/Embeds.ts"
import type { Presence } from "../discord/Presence.ts"
import type { Fleet } from "../opencode/Fleet.ts"
import type { ChannelId, MessageId, ServerName, UserId } from "../shared/Ids.ts"
import type { Tasks } from "../tasks/Tasks.ts"

export type Call = Data.TaggedEnum<{
  Reply: {
    readonly text: string
    readonly replyTo: Option.Option<MessageId>
    readonly files: ReadonlyArray<string>
    readonly embeds: ReadonlyArray<Embeds.Embed>
    readonly mention: Option.Option<UserId>
  }
  React: { readonly messageId: MessageId; readonly emoji: string }
  StartTask: { readonly messageId: Option.Option<MessageId>; readonly title: string; readonly brief: string }
  ContinueTask: {
    readonly threadId: ChannelId
    readonly request: string
    readonly messageId: Option.Option<MessageId>
  }
  UpdateTask: {
    readonly summary: Option.Option<string>
    readonly status: Option.Option<Tasks.Task["status"]>
  }
  SetModel: { readonly model: string; readonly scope: ModelScope }
  SetProfile: { readonly change: ProfileChange }
  Remember: {
    readonly about: "person" | "server"
    readonly userId: Option.Option<UserId>
    readonly kind: Option.Option<"profile" | "fact">
    readonly text: string
    readonly replaces: Option.Option<string>
    readonly expires: Option.Option<string>
    readonly messageId: Option.Option<MessageId>
  }
  Forget: { readonly id: Option.Option<string>; readonly match: Option.Option<string> }
}>

/** `null` removes or clears the field. Fields that are not set stay as they are. */
export interface ProfileChange {
  readonly username?: string | undefined
  readonly avatar?: string | null | undefined
  readonly banner?: string | null | undefined
  readonly about?: string | null | undefined
  readonly nickname?: string | null | undefined
  readonly status?: Presence.Status | undefined
  readonly activity?: Presence.Activity | null | undefined
}

export type ModelScope = "conversation" | "default"

export const Call = Data.taggedEnum<Call>()

/** One kind of call, for example `CallOf<"Reply">`. */
export type CallOf<Tag extends Call["_tag"]> = Data.TaggedEnum.Value<Call, Tag>

/** The message goes back to the agent as the tool's error. */
export class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolCalls.ToolFailure", {
  message: Schema.String,
}) {}

export const fail = (message: string) => Effect.fail(new ToolFailure({ message }))

/** For `Effect.mapError`: replaces any error with `message`, so internal details do not reach the agent. */
export const failure = (message: string) => () => new ToolFailure({ message })

/** Where a tool call came from: the server, and the conversation at the top of the call's session tree. */
export interface Target {
  readonly remote: Fleet.Remote
  readonly channelId: ChannelId
}

export interface Request {
  readonly server: ServerName
  readonly sessionID: string
  readonly call: Call
  readonly done: Deferred.Deferred<string, ToolFailure>
}

export interface Interface {
  readonly submit: (server: ServerName, sessionID: string, call: Call) => Effect.Effect<string, ToolFailure>
  readonly requests: Stream.Stream<Request>
}

export class Service extends Context.Service<Service, Interface>()("wendell/ToolCalls") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Request>()

    const submit = Effect.fn("ToolCalls.submit")(function* (server: ServerName, sessionID: string, call: Call) {
      const done = yield* Deferred.make<string, ToolFailure>()

      yield* Queue.offer(queue, { server, sessionID, call, done })

      return yield* Deferred.await(done)
    })

    return Service.of({ submit, requests: Stream.fromQueue(queue) })
  }),
)

export * as ToolCalls from "./ToolCalls.ts"
