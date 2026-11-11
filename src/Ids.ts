import { Schema } from "effect"

const snowflake = Schema.String.check(Schema.isPattern(/^\d{1,20}$/))

export const ChannelId = snowflake.pipe(Schema.brand("ChannelId"))

export type ChannelId = typeof ChannelId.Type

export const MessageId = snowflake.pipe(Schema.brand("MessageId"))

export type MessageId = typeof MessageId.Type

export const UserId = snowflake.pipe(Schema.brand("UserId"))

export type UserId = typeof UserId.Type

export const GuildId = snowflake.pipe(Schema.brand("GuildId"))

export type GuildId = typeof GuildId.Type

export const RoleId = snowflake.pipe(Schema.brand("RoleId"))

export type RoleId = typeof RoleId.Type

export const ServerName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/, { message: "Use lowercase letters, digits and dashes" }),
).pipe(Schema.brand("ServerName"))

export type ServerName = typeof ServerName.Type

export * as Ids from "./Ids.ts"
