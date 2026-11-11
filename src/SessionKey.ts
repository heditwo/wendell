import { Session } from "@opencode/client/effect"
import { Option, Schema } from "effect"
import { ChannelId } from "./Ids.ts"

const PREFIX = "ses_discord_"

const decodeChannelId = Schema.decodeOption(ChannelId)

export const forChannel = (channelId: ChannelId) => Session.ID.make(`${PREFIX}${channelId}`)

export const channelOf = (sessionID: string): Option.Option<ChannelId> =>
  sessionID.startsWith(PREFIX) ? decodeChannelId(sessionID.slice(PREFIX.length)) : Option.none()

/** Session IDs from server events, which are already validated. */
export const forSessionID = (sessionID: string) => Session.ID.make(sessionID)

export * as SessionKey from "./SessionKey.ts"
