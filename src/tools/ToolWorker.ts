import { Deferred, Effect, Layer, Option, Stream } from "effect"
import { Conversations } from "../conversations/Conversations.ts"
import { Fleet } from "../opencode/Fleet.ts"
import { SessionKey } from "../opencode/SessionKey.ts"
import { ExpressionTools } from "./handlers/ExpressionTools.ts"
import { MemoryTools } from "./handlers/MemoryTools.ts"
import { ModelTools } from "./handlers/ModelTools.ts"
import { ProfileTools } from "./handlers/ProfileTools.ts"
import { ReplyTools } from "./handlers/ReplyTools.ts"
import { TaskTools } from "./handlers/TaskTools.ts"
import { VoiceTools } from "./handlers/VoiceTools.ts"
import { ToolCalls } from "./ToolCalls.ts"

/** Answers the client MCP tool calls from the queue, each with the handler for its kind. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const toolCalls = yield* ToolCalls.Service
    const fleet = yield* Fleet.Service
    const conversations = yield* Conversations.Service
    const replies = yield* ReplyTools.make
    const taskTools = yield* TaskTools.make
    const modelTools = yield* ModelTools.make
    const profileTools = yield* ProfileTools.make
    const memoryTools = yield* MemoryTools.make
    const expressionTools = yield* ExpressionTools.make
    const voiceTools = yield* VoiceTools.make

    const remoteOf = (request: ToolCalls.Request) =>
      Option.match(fleet.byName(request.server), {
        onNone: () => ToolCalls.fail("This server is not connected."),
        onSome: Effect.succeed,
      })

    // Subagents' tool calls belong to the conversation at the top of their session tree.
    const channelOf = (remote: Fleet.Remote, sessionID: string) =>
      conversations.rootOf(remote, sessionID).pipe(
        Effect.map(Option.flatMap(SessionKey.channelOf)),
        Effect.flatMap(
          Option.match({
            onNone: () => ToolCalls.fail("This session is not a Wendell conversation."),
            onSome: Effect.succeed,
          }),
        ),
      )

    const handle = Effect.fn("ToolWorker.handle")(function* (request: ToolCalls.Request) {
      const remote = yield* remoteOf(request)
      const target: ToolCalls.Target = { remote, channelId: yield* channelOf(remote, request.sessionID) }

      return yield* ToolCalls.Call.$match(request.call, {
        Reply: (call) => replies.reply(target, call),
        React: (call) => replies.react(target, call),
        StartTask: (call) => taskTools.startTask(target, call),
        ContinueTask: (call) => taskTools.continueTask(target, call),
        UpdateTask: (call) => taskTools.updateTask(target, call),
        SetModel: (call) => modelTools.setModel(target, call),
        SetProfile: (call) => profileTools.setProfile(target, call),
        AddExpression: (call) => expressionTools.add(target, call),
        ListExpressions: (call) => expressionTools.list(target, call),
        EditExpression: (call) => expressionTools.edit(target, call),
        RemoveExpression: (call) => expressionTools.remove(target, call),
        Remember: (call) => memoryTools.remember(target, call),
        Forget: (call) => memoryTools.forget(target, call),
        JoinVoice: (call) => voiceTools.join(target, call),
        LeaveVoice: () => voiceTools.leave(target),
      })
    })

    yield* toolCalls.requests.pipe(
      Stream.runForEach((request) =>
        handle(request).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(request.done, exit)),
          Effect.forkScoped,
        ),
      ),
      Effect.forkScoped,
    )
  }),
)

export * as ToolWorker from "./ToolWorker.ts"
