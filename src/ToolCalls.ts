import { Context, Data, Deferred, Effect, Layer, type Option, Queue, Schema, Stream } from "effect"
import type { ChannelId, MessageId, ServerName } from "./Ids.ts"
import type { Tasks } from "./Tasks.ts"

export type Call = Data.TaggedEnum<{
  Reply: { readonly text: string; readonly replyTo: Option.Option<MessageId> }
  React: { readonly messageId: MessageId; readonly emoji: string }
  StartTask: { readonly messageId: MessageId; readonly title: string; readonly brief: string }
  ContinueTask: {
    readonly threadId: ChannelId
    readonly request: string
    readonly messageId: Option.Option<MessageId>
  }
  UpdateTask: {
    readonly summary: Option.Option<string>
    readonly status: Option.Option<Tasks.Task["status"]>
  }
}>

export const Call = Data.taggedEnum<Call>()

export class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolCalls.ToolFailure", {
  message: Schema.String,
}) {}

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
