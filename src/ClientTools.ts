import type { ClientMcpTool, ClientMcpToolResult } from "@opencode/client/mcp"
import { Effect, Option, Schema } from "effect"
import { Embeds } from "./Embeds.ts"
import { ChannelId, MessageId, type ServerName, UserId } from "./Ids.ts"
import { ToolCalls } from "./ToolCalls.ts"

const ReplyArgs = Schema.Struct({
  text: Schema.NonEmptyString.annotate({ description: "Message text. Discord markdown. At most 2000 characters." }),
  reply_to: Schema.optional(MessageId).annotate({
    description: "ID of the message to reply to. Use it when you answer one specific message.",
  }),
  files: Schema.optional(Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(10))).annotate({
    description:
      "Files to attach: paths on this machine, absolute or relative to your working directory. At most 10 files and 25 MB. " +
      "Use it for images, screenshots, charts and small files that people should see.",
  }),
  embeds: Schema.optional(Embeds.List).annotate({
    description:
      "Discord embeds for structured results, at most 10 and 6000 characters together. Not for normal chat. " +
      "An image or thumbnail can show an attached file with attachment://<file name>.",
  }),
  mention: Schema.optional(UserId).annotate({
    description:
      "User ID to ping, for example the person who asked for a reminder. Only this user is pinged; never more than one person.",
  }),
})

const ReactArgs = Schema.Struct({
  message_id: MessageId.annotate({ description: "ID of the message to react to." }),
  emoji: Schema.NonEmptyString.annotate({ description: "One Unicode emoji, for example 👍." }),
})

const StartTaskArgs = Schema.Struct({
  message_id: Schema.optional(MessageId).annotate({
    description: "In a channel (required): ID of the message that asked for the work. The thread starts from it. Omit it in a task thread.",
  }),
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

const SetModelArgs = Schema.Struct({
  model: Schema.NonEmptyString.annotate({
    description: 'Model as "provider/model", with an optional "#variant", for example "anthropic-personal/claude-haiku-4-5".',
  }),
  scope: Schema.optional(Schema.Literals(["conversation", "default"])).annotate({
    description: '"conversation" (default): this conversation only. "default": new conversations on this server.',
  }),
})

const inputSchema = (schema: Schema.Top) => Schema.toJsonSchemaDocument(schema).schema

const text = (value: string): ClientMcpToolResult => ({ content: [{ type: "text", text: value }] })

const MAX_ISSUE = 1000

const invalidArguments = (error: Schema.SchemaError) =>
  new ToolCalls.ToolFailure({ message: `Invalid arguments: ${error.message.slice(0, MAX_ISSUE)}` })

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
      (input) =>
        ToolCalls.Call.Reply({
          text: input.text,
          replyTo: Option.fromUndefinedOr(input.reply_to),
          files: input.files ?? [],
          embeds: input.embeds ?? [],
          mention: Option.fromUndefinedOr(input.mention),
        }),
    ),
    tool(
      "react",
      "Add an emoji reaction to a message. Use it for a light acknowledgement when a full reply is not needed.",
      ReactArgs,
      (input) => ToolCalls.Call.React({ messageId: input.message_id, emoji: input.emoji }),
    ),
    tool(
      "start_task",
      "In a channel: move real work (building, changing or investigating something over several steps) into its own Discord thread " +
        "with its own project directory. After it succeeds, do not reply in the channel. " +
        "In a task thread: start a sub-task for a large, independent part of the work, in a new thread. " +
        "It gets a git worktree when the task directory is in a git repository; otherwise it shares the task directory. " +
        "When the sub-task calls update_task with status \"done\", its result is reported back to this task. Not available in DMs.",
      StartTaskArgs,
      (input) =>
        ToolCalls.Call.StartTask({
          messageId: Option.fromUndefinedOr(input.message_id),
          title: input.title,
          brief: input.brief,
        }),
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
        "Call it after meaningful progress, and with status \"done\" when the work is finished. " +
        "In a sub-task, status \"done\" reports the summary to the parent task.",
      UpdateTaskArgs,
      (input) =>
        ToolCalls.Call.UpdateTask({
          summary: Option.fromUndefinedOr(input.summary),
          status: Option.fromUndefinedOr(input.status),
        }),
    ),
    tool(
      "set_model",
      "Change the model that answers in this conversation, or the default model for new conversations on this server. " +
        "Use it when someone asks for another model. If the model is unknown, the error lists close matches. " +
        "A change of this conversation applies from your next turn.",
      SetModelArgs,
      (input) => ToolCalls.Call.SetModel({ model: input.model, scope: input.scope ?? "conversation" }),
    ),
  ]
}

export * as ClientTools from "./ClientTools.ts"
