import { Effect, Schema } from "effect"

const CONNECT_PATH = "/auth/connect/"

export class InvalidLink extends Schema.TaggedError<InvalidLink>()("Pairing.InvalidLink", {
  message: Schema.String,
}) {}

export interface Link {
  readonly baseUrl: string
  readonly code: string
}

/** Splits an `opencode pair` link into the server base URL and the one-time code. */
export const parseLink = (link: string): Effect.Effect<Link, InvalidLink> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(link),
      catch: () => new InvalidLink({ message: `Not a URL: ${link}` }),
    })

    const index = url.pathname.indexOf(CONNECT_PATH)
    const code = url.pathname.slice(index + CONNECT_PATH.length)

    if (index < 0 || code === "" || code.includes("/")) {
      return yield* new InvalidLink({ message: "Expected a pairing link that contains /auth/connect/<code>." })
    }

    return { baseUrl: `${url.origin}${url.pathname.slice(0, index)}`, code }
  })

export * as Pairing from "./Pairing.ts"
