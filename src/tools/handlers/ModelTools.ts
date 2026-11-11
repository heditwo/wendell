import { Effect, Option } from "effect"
import { Conversations } from "../../conversations/Conversations.ts"
import { Models } from "../../opencode/Models.ts"
import { SessionKey } from "../../opencode/SessionKey.ts"
import { ToolCalls } from "../ToolCalls.ts"

/** `wendell_set_model`. Models go through `Models.resolve`, which refuses blocked providers. */
export const make = Effect.gen(function* () {
  const conversations = yield* Conversations.Service
  const models = yield* Models.Service

  const setModel = Effect.fn("ModelTools.setModel")(function* (
    { remote, channelId }: ToolCalls.Target,
    { model, scope }: ToolCalls.CallOf<"SetModel">,
  ) {
    const conversation = yield* conversations.forSession(remote.name, SessionKey.forChannel(channelId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => ToolCalls.fail("This conversation is not ready yet. Try again in your next turn."),
          onSome: Effect.succeed,
        }),
      ),
    )

    const resolved = yield* models.resolve(remote, conversation.directory, model).pipe(
      Effect.catchTags({
        "Models.UnknownModel": (error) => ToolCalls.fail(error.message),
        "Models.CatalogError": () => ToolCalls.fail("Could not read the server's models."),
      }),
    )

    if (scope === "default") {
      yield* models.setDefault(remote, resolved.id).pipe(Effect.mapError(ToolCalls.failure("Could not save the model.")))

      return `New conversations on ${remote.name} now use ${resolved.name} (${resolved.id}). Existing conversations keep their model.`
    }

    yield* conversations.setModel(conversation, resolved).pipe(Effect.mapError(ToolCalls.failure("Could not switch the model.")))

    return `This conversation now uses ${resolved.name} (${resolved.id}), from your next turn.`
  })

  return { setModel }
})

export * as ModelTools from "./ModelTools.ts"
