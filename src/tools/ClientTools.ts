import type { ClientMcpTool, ClientMcpToolResult } from "@opencode/client/mcp"
import { Effect, Option, Schema } from "effect"
import { Embeds } from "../discord/Embeds.ts"
import { Presence } from "../discord/Presence.ts"
import { ChannelId, MessageId, type ServerName, UserId } from "../shared/Ids.ts"
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
    description: 'Model as "provider/model", with an optional "#variant", using the provider and model IDs that the server lists.',
  }),
  scope: Schema.optional(Schema.Literals(["conversation", "default"])).annotate({
    description: '"conversation" (default): this conversation only. "default": new conversations on this server.',
  }),
})

const SetProfileArgs = Schema.Struct({
  username: Schema.optional(Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(32))).annotate({
    description: "New global username. Discord allows about 2 changes per hour.",
  }),
  avatar: Schema.optional(Schema.NullOr(Schema.NonEmptyString)).annotate({
    description: "Path of a PNG, JPEG, GIF or WebP file on the server (relative to your working directory), or null to remove the avatar.",
  }),
  banner: Schema.optional(Schema.NullOr(Schema.NonEmptyString)).annotate({
    description: "Path of an image file on the server for the profile banner, or null to remove it.",
  }),
  about: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(400)))).annotate({
    description: 'The "About me" text on the profile, or null to clear it.',
  }),
  nickname: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)))).annotate({
    description: "Nickname in this Discord server only, or null to go back to the username. Not available in DMs.",
  }),
  status: Schema.optional(Presence.Status).annotate({
    description: 'Online status. "dnd" is Do Not Disturb.',
  }),
  activity: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        type: Presence.ActivityType,
        text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
      }),
    ),
  ).annotate({
    description: 'What the profile shows, for example { "type": "listening", "text": "the rain" } or a custom status. null clears it.',
  }),
})

const RememberArgs = Schema.Struct({
  about: Schema.Literals(["person", "server"]).annotate({
    description: '"person": about one person, follows them across servers. "server": about this Discord server and its people as a group.',
  }),
  user_id: Schema.optional(UserId).annotate({ description: "For about=person: the person's user ID (author_id in messages)." }),
  text: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(300)).annotate({
    description: "One short, self-contained fact, as you would note it: \"Plays OSRS, main account is an ironman.\"",
  }),
  replaces: Schema.optional(Schema.NonEmptyString).annotate({
    description: "ID of a note this one updates or merges (for example m_1a2b3c). Use it instead of adding a near-duplicate.",
  }),
  expires: Schema.optional(Schema.NonEmptyString).annotate({
    description: 'For facts that stop mattering: a date or time, for example "2026-11-20". The note disappears after it.',
  }),
  message_id: Schema.optional(MessageId).annotate({ description: "The message you learned it from." }),
})

const ForgetArgs = Schema.Struct({
  id: Schema.NonEmptyString.annotate({ description: "ID of the note to remove, for example m_1a2b3c." }),
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
    tool(
      "set_profile",
      "Change your Discord profile: username, avatar, banner, \"About me\", your nickname in this server, your online status " +
        "and your activity. Set only the fields that should change. Status and activity stay after a restart. " +
        "To make a new avatar, create the image with image_generate first, then pass its path.",
      SetProfileArgs,
      (input) => ToolCalls.Call.SetProfile({ change: input }),
    ),
    tool(
      "remember",
      "Keep a note in your long-term memory, about one person or about this server. Notes come back automatically " +
        "in later conversations. Note what a thoughtful friend would remember: lasting facts, preferences and things " +
        "that matter to people. Not passing remarks. Notes learned in a DM stay private to DMs with that person.",
      RememberArgs,
      (input) =>
        ToolCalls.Call.Remember({
          about: input.about,
          userId: Option.fromUndefinedOr(input.user_id),
          text: input.text,
          replaces: Option.fromUndefinedOr(input.replaces),
          expires: Option.fromUndefinedOr(input.expires),
          messageId: Option.fromUndefinedOr(input.message_id),
        }),
    ),
    tool(
      "forget",
      "Remove a note from your memory, when it is wrong, out of date, or someone asks you to forget it.",
      ForgetArgs,
      (input) => ToolCalls.Call.Forget({ id: input.id }),
    ),
  ]
}

export * as ClientTools from "./ClientTools.ts"
