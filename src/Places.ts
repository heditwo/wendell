import { AbsolutePath } from "@opencode/client/effect"
import { Context, Effect, Layer, Option } from "effect"
import path from "node:path"
import { Access } from "./Access.ts"
import type { Conversations } from "./Conversations.ts"
import { Discord } from "./Discord.ts"
import { Fleet } from "./Fleet.ts"
import type { ChannelId, GuildId, UserId } from "./Ids.ts"
import { Inbound } from "./Inbound.ts"
import { Tasks } from "./Tasks.ts"
import { WendellConfig } from "./WendellConfig.ts"

export interface Place {
  readonly conversation: Conversations.Conversation
  readonly goal: Option.Option<WendellConfig.Goal>
  readonly isThread: boolean
  readonly task: Option.Option<Tasks.Task>
}

/** Where something happened in Discord, and who did it. */
export interface Origin {
  readonly channelId: ChannelId
  readonly guildId: Option.Option<GuildId>
  readonly member: Access.Member
  readonly authorId: UserId
  readonly authorName: string
}

export interface Interface {
  readonly forMessage: (message: Inbound.Message) => Effect.Effect<Place, Fleet.ServerRequestError>
  readonly forOrigin: (origin: Origin) => Effect.Effect<Place, Fleet.ServerRequestError>
  readonly forTask: (task: Tasks.Task) => Conversations.Conversation
}

export class Service extends Context.Service<Service, Interface>()("wendell/Places") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fleet = yield* Fleet.Service
    const config = yield* WendellConfig.Service
    const discord = yield* Discord.Service
    const tasks = yield* Tasks.Service
    const access = yield* Access.Service

    const channelInfo = (channelId: ChannelId) =>
      discord.channel(channelId).pipe(
        Effect.map(Option.some),
        Effect.catch((cause) =>
          Effect.logWarning("Could not read channel", { channelId, cause }).pipe(
            Effect.as(Option.none<Discord.ChannelInfo>()),
          ),
        ),
      )

    const remoteFor = (server: Option.Option<WendellConfig.Channel["server"]>, channelId: ChannelId) =>
      Option.match(Option.flatMap(server, Option.fromUndefinedOr), {
        onNone: () => Effect.succeed(fleet.fallback),
        onSome: (name) =>
          Option.match(fleet.byName(name), {
            onNone: () =>
              Effect.logWarning("Channel server is not connected, using the default server", {
                channelId,
                server: name,
              }).pipe(Effect.as(fleet.fallback)),
            onSome: Effect.succeed,
          }),
      })

    const forTask = (task: Tasks.Task): Conversations.Conversation => ({
      kind: "task",
      channelId: task.threadId,
      guildId: Option.fromUndefinedOr(task.guildId),
      remote: Option.getOrElse(fleet.byName(task.server), () => fleet.fallback),
      directory: AbsolutePath.make(task.directory),
      tier: task.trusted ? "trusted" : "guest",
      title: task.title,
    })

    const forOrigin = Effect.fn("Places.forOrigin")(function* (message: Origin) {
      const task = yield* tasks.get(message.channelId)

      if (Option.isSome(task)) {
        return { conversation: forTask(task.value), goal: Option.none(), isThread: true, task }
      }

      if (Option.isNone(message.guildId)) {
        const remote = fleet.fallback
        const directory = AbsolutePath.make(path.join(remote.directory, `dm-${message.authorId}`))
        const trusted = yield* access.trusted(message.member)

        yield* fleet.makeDirectory(remote, directory)

        return {
          conversation: {
            kind: "dm",
            channelId: message.channelId,
            guildId: Option.none(),
            remote,
            directory,
            tier: trusted ? "trusted" : "guest",
            title: `DM with ${message.authorName}`,
          },
          goal: Option.none(),
          isThread: false,
          task,
        } satisfies Place
      }

      // Threads that Wendell did not start inherit the server and goal of their parent channel.
      const info = yield* channelInfo(message.channelId)
      const own = config.channel(message.channelId)

      const parent = info.pipe(
        Option.flatMap((channel) => channel.parentId),
        Option.flatMap(config.channel),
      )

      const pick = <A>(get: (channel: WendellConfig.Channel) => A | undefined) =>
        Option.flatMap(own, (channel) => Option.fromUndefinedOr(get(channel))).pipe(
          Option.orElse(() => Option.flatMap(parent, (channel) => Option.fromUndefinedOr(get(channel)))),
        )

      const remote = yield* remoteFor(pick((channel) => channel.server), message.channelId)

      return {
        conversation: {
          kind: "channel",
          channelId: message.channelId,
          guildId: message.guildId,
          remote,
          directory: remote.directory,
          // A channel session is shared by everyone in it, so it is only trusted when everyone is.
          tier: access.everyoneTrusted(message.guildId) ? "trusted" : "guest",
          title: `Discord channel ${message.channelId}`,
        },
        goal: pick((channel) => channel.goal),
        isThread: Option.exists(info, (channel) => channel.isThread),
        task,
      } satisfies Place
    })

    const forMessage = (message: Inbound.Message) =>
      forOrigin({
        channelId: message.channelId,
        guildId: message.guildId,
        member: Inbound.member(message),
        authorId: message.authorId,
        authorName: message.authorName,
      })

    return Service.of({ forMessage, forOrigin, forTask })
  }),
)

export * as Places from "./Places.ts"
