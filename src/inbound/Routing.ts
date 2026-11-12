import { Data, Option } from "effect"
import type { WendellConfig } from "../config/WendellConfig.ts"

export type Route = Data.TaggedEnum<{
  /** A mention, a reply to Wendell, a DM, or "Wendell, ..." */
  Addressed: {}
  /** Wendell's name appears, but maybe only in passing. */
  Named: {}
  /** A voice message without his name: speech recognition often mishears "Wendell". */
  Spoken: {}
  /** A message in one of Wendell's task threads. */
  Task: {}
  /** Speech in a voice call that Wendell is in, without his name at the start or end. */
  Call: {}
  FollowUp: {}
  Watched: { readonly goal: WendellConfig.Goal }
  Ignored: {}
}>

export const Route = Data.taggedEnum<Route>()

export interface Facts {
  readonly fromBot: boolean
  readonly addressed: boolean
  readonly named: boolean
  readonly spoken: boolean
  readonly inTask: boolean
  readonly inCall: boolean
  readonly following: boolean
  readonly goal: Option.Option<WendellConfig.Goal>
}

const NAME = String.raw`wendell`
const GREETING = String.raw`(?:hey|hi|hello|yo|oi|ok|okay|so|and|also|thanks|thank you|ty)`

const vocativeStart = new RegExp(String.raw`^\s*(?:${GREETING}[\s,!]+)?@?${NAME}\b`, "i")
const vocativeEnd = new RegExp(String.raw`[\s,]@?${NAME}[\s!?.]*$`, "i")
const anywhere = new RegExp(String.raw`\b${NAME}\b`, "i")

/** "Wendell, look into this", "hey wendell", "can you do this, Wendell?" */
export const addressesByName = (content: string) => vocativeStart.test(content) || vocativeEnd.test(content)

export const mentionsName = (content: string) => anywhere.test(content)

export const classify = (facts: Facts): Route => {
  if (facts.fromBot) return Route.Ignored()

  if (facts.addressed) return Route.Addressed()

  if (facts.inTask) return Route.Task()

  if (facts.inCall) return Route.Call()

  if (facts.named) return Route.Named()

  if (facts.spoken) return Route.Spoken()

  if (facts.following) return Route.FollowUp()

  return Option.match(facts.goal, {
    onNone: () => Route.Ignored(),
    onSome: (goal) => Route.Watched({ goal }),
  })
}

export const screenQuestion: (route: Route) => Option.Option<string> = Route.$match({
  Addressed: () => Option.none(),
  Task: () => Option.none(),
  Ignored: () => Option.none(),
  Named: () =>
    Option.some(
      "Wendell is an AI agent in this chat. The latest message contains his name. " +
        "Is it talking to Wendell or asking him to do something? Talking about him to someone else does not count.",
    ),
  Spoken: () =>
    Option.some(
      "Wendell is an AI agent in this chat. The latest message is a transcribed voice message, and speech recognition " +
        'often mishears the name "Wendell" (for example as "window", "Wendel" or "Randall"). ' +
        "Is it talking to Wendell or asking him to do something? Talking to someone else does not count.",
    ),
  Call: () =>
    Option.some(
      "Wendell is an AI agent in this voice call, and everyone in the call hears him. The latest line is speech " +
        'recognition of what one person said. It can contain errors, and it often mishears the name "Wendell" ' +
        '(for example as "window", "Wendel" or "Randall"). Could this latest line be for Wendell? ' +
        "Talk between other people, banter and acknowledgements between them are not for him.",
    ),
  FollowUp: () =>
    Option.some(
      "An AI agent named Wendell is taking part in this conversation. Could this latest message be for it? " +
        "Replies to other people, banter and acknowledgements between them are not for it.",
    ),
  Watched: ({ goal }) =>
    Option.some(
      `An AI agent named Wendell listens to this channel for this goal:\n${goal.wakeWhen}\n` +
        "Could this latest message need its help? Social chat, announcements and messages unrelated to the goal are not for it.",
    ),
})

export const guidance: (route: Route) => string = Route.$match({
  Addressed: () => "Someone addressed you directly. Reply.",
  Named: () => "This message uses your name. Reply if it is meant for you. Otherwise stay silent.",
  Spoken: () =>
    "This is a voice message. Speech recognition may have misheard your name. Reply if it is meant for you. Otherwise stay silent.",
  Task: () =>
    "This message is in your task thread. Act on requests and feedback about the task. Stay silent for side chatter.",
  Call: () =>
    "This was said in the voice call that you are in. Speech recognition may have misheard words, also your name. " +
    "Answer only if it is meant for you or you can clearly help. Otherwise stay silent.",
  Ignored: () => "Do not reply.",
  FollowUp: () =>
    "This message doesn't mention you, but you took part in this conversation recently. " +
    "Answer only if it is meant for you. Otherwise stay silent.",
  Watched: () =>
    "This message doesn't mention you. Answer only if your channel goal applies and you can add something useful. " +
    "Otherwise stay silent.",
})

export const isActionable: (route: Route) => boolean = Route.$match({
  Addressed: () => true,
  Named: () => true,
  Spoken: () => true,
  Task: () => true,
  Call: () => true,
  FollowUp: () => true,
  Watched: () => true,
  Ignored: () => false,
})

/** Turns where someone is waiting on Wendell: show progress, and never end in silence. */
export const expectsReply: (route: Route) => boolean = Route.$match({
  Addressed: () => true,
  Named: () => false,
  Spoken: () => false,
  Task: () => false,
  Call: () => false,
  FollowUp: () => false,
  Watched: () => false,
  Ignored: () => false,
})

/** Turns that show live progress when Wendell starts using tools. */
export const showsProgress: (route: Route) => boolean = Route.$match({
  Addressed: () => true,
  Named: () => true,
  Spoken: () => true,
  Task: () => true,
  Call: () => false,
  FollowUp: () => false,
  Watched: () => false,
  Ignored: () => false,
})

export * as Routing from "./Routing.ts"
