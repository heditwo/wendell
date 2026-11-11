import type { ClientMcpTool, ClientMcpToolResult } from "@opencode/client/mcp"
import { Effect, Option, Schema } from "effect"
import { ChannelId, MessageId, type ServerName } from "./Ids.ts"
import { ToolCalls } from "./ToolCalls.ts"

const ReplyArgs = Schema.Struct({
  text: Schema.NonEmptyString.annotate({ description: "Message text. Discord markdown. At most 2000 characters." }),
  reply_to: Schema.optional(MessageId).annotate({
    description: "ID of the message to reply to. Use it when you answer one specific message.",
  }),
})

const ReactArgs = Schema.Struct({
  message_id: MessageId.annotate({ description: "ID of the message to react to." }),
  emoji: Schema.NonEmptyString.annotate({ description: "One Unicode emoji, for example 👍." }),
})

const StartTaskArgs = Schema.Struct({
  message_id: MessageId.annotate({ description: "ID of the message that asked for the work. The thread starts from it." }),
  title: Schema.NonEmptyString.annotate({ description: "Short thread name, for example \"Todo app\"." }),
  brief: Schema.NonEmptyString.annotate({
    description: "What to do, with everything relevant from this conversation. The task starts with this brief.",
  }),
})

const ContinueTaskArgs = Schema.Struct({
  thread_id: ChannelId.annotate({ description: "Thread ID of the task, from the task list in your instructions." }),
  request: Schema.NonEmptyString.annotate({ description: "What the person asked, in their words." }),
  message_id: Schema.optional(MessageId).annotate({ description: "ID of the message that asked for it." }),
})

const UpdateTaskArgs = Schema.Struct({
  summary: Schema.optional(Schema.NonEmptyString).annotate({
    description: "One or two sentences: what this task is and where it stands, including links you shared.",
  }),
  status: Schema.optional(Schema.Literals(["active", "done"])),
})

const inputSchema = (schema: Schema.Top) => Schema.toJsonSchemaDocument(schema).schema

const text = (value: string): ClientMcpToolResult => ({ content: [{ type: "text", text: value }] })

const invalidArguments = () => new ToolCalls.ToolFailure({ message: "Invalid arguments." })

/** The tools Wendell attaches to an OpenCode server. Each call goes to the tool worker. */
export const make = (
  server: ServerName,
  toolCalls: ToolCalls.Interface,
  run: <A>(effect: Effect.Effect<A>) => Promise<A>,
): ReadonlyArray<ClientMcpTool> => {
  const tool = <S extends Schema.Top & { readonly DecodingServices: never }>(
    name: string,
    description: string,
    args: S,
    toCall: (input: S["Type"]) => ToolCalls.Call,
  ): ClientMcpTool => ({
    name,
    description,
    inputSchema: inputSchema(args),
    handler: (raw, context) =>
      run(
        Effect.gen(function* () {
          const sessionID = yield* Option.match(Option.fromUndefinedOr(context.sessionID), {
            onNone: () => Effect.fail(new ToolCalls.ToolFailure({ message: "Missing session." })),
            onSome: Effect.succeed,
          })

          const input = yield* Schema.decodeUnknownEffect(args)(raw).pipe(Effect.mapError(invalidArguments))

          return yield* toolCalls.submit(server, sessionID, toCall(input))
        }).pipe(
          Effect.map(text),
          Effect.catch((error) => Effect.succeed({ ...text(error.message), isError: true })),
        ),
      ),
  })

  return [
    tool(
      "reply",
      "Post a message in the current Discord conversation. This is the only way to speak. Call it at most once per batch of messages.",
      ReplyArgs,
      (input) => ToolCalls.Call.Reply({ text: input.text, replyTo: Option.fromUndefinedOr(input.reply_to) }),
    ),
    tool(
      "react",
      "Add an emoji reaction to a message. Use it for a light acknowledgement when a full reply is not needed.",
      ReactArgs,
      (input) => ToolCalls.Call.React({ messageId: input.message_id, emoji: input.emoji }),
    ),
    tool(
      "start_task",
      "Move real work (building, changing or investigating something over several steps) into its own Discord thread " +
        "with its own project directory. Use it in a channel, not in a task thread or a DM. After it succeeds, do not reply in the channel.",
      StartTaskArgs,
      (input) => ToolCalls.Call.StartTask({ messageId: input.message_id, title: input.title, brief: input.brief }),
    ),
    tool(
      "continue_task",
      "Send a request about an existing task to its thread, for example \"that app from yesterday\". " +
        "After it succeeds, do not reply in the channel.",
      ContinueTaskArgs,
      (input) =>
        ToolCalls.Call.ContinueTask({
          threadId: input.thread_id,
          request: input.request,
          messageId: Option.fromUndefinedOr(input.message_id),
        }),
    ),
    tool(
      "update_task",
      "In a task thread: record what the task is and where it stands, so you can find it again later. " +
        "Call it after meaningful progress, and with status \"done\" when the work is finished.",
      UpdateTaskArgs,
      (input) =>
        ToolCalls.Call.UpdateTask({
          summary: Option.fromUndefinedOr(input.summary),
          status: Option.fromUndefinedOr(input.status),
        }),
    ),
  ]
}

export * as ClientTools from "./ClientTools.ts"
