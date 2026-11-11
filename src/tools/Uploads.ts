import { AbsolutePath } from "@opencode/client/effect"
import { Context, Effect, Layer, Option, Schema } from "effect"
import path from "node:path"
import type { Discord } from "../discord/Discord.ts"
import { Fleet } from "../opencode/Fleet.ts"
import { Policy } from "../opencode/Policy.ts"
import { SessionKey } from "../opencode/SessionKey.ts"
import { Files } from "../shared/Files.ts"
import type { ChannelId } from "../shared/Ids.ts"
import { Tasks } from "../tasks/Tasks.ts"

/** Discord's limits for servers without boosts. */
export const MAX_FILES = 10
export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024

export class FileRefused extends Schema.TaggedError<FileRefused>()("Uploads.FileRefused", {
  message: Schema.String,
}) {}

export interface Interface {
  /**
   * Reads files from the server for a Discord message in a conversation. Relative paths start at the
   * conversation's directory. Files may come only from that directory, the directories of its tasks and
   * the server's temporary directory, and `.env` files are refused.
   */
  readonly load: (
    remote: Fleet.Remote,
    channelId: ChannelId,
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Discord.Upload>, FileRefused>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Uploads") {}

const refuse = (message: string) => Effect.fail(new FileRefused({ message }))

const rootOf = (roots: ReadonlyArray<AbsolutePath>, file: string) =>
  Option.fromUndefinedOr(roots.find((root) => file === root || file.startsWith(`${root.replace(/\/+$/, "")}/`)))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fleet = yield* Fleet.Service
    const tasks = yield* Tasks.Service

    const roots = Effect.fn("Uploads.roots")(function* (remote: Fleet.Remote, channelId: ChannelId) {
      const session = yield* remote.client.session
        .get({ sessionID: SessionKey.forChannel(channelId) })
        .pipe(Effect.mapError(() => new FileRefused({ message: "Could not read this conversation's session." })))

      const directory = session.location.directory

      const related = (yield* tasks.all).flatMap((task) =>
        task.server === remote.name &&
        (task.threadId === channelId || task.parentTaskId === channelId || (task.parentId === channelId && task.parentTaskId === undefined))
          ? [AbsolutePath.make(task.directory)]
          : [],
      )

      return { directory, roots: [directory, ...related, remote.tmp] }
    })

    const load = Effect.fn("Uploads.load")(function* (remote: Fleet.Remote, channelId: ChannelId, paths: ReadonlyArray<string>) {
      const allowed = yield* roots(remote, channelId)

      if (paths.length > MAX_FILES) return yield* refuse(`Discord allows at most ${MAX_FILES} files per message.`)

      const uploads = new Array<Discord.Upload>()
      const taken = new Set<string>()
      let total = 0

      for (const requested of paths) {
        const file = path.resolve(allowed.directory, requested)

        if (Policy.isSecretFile(file)) return yield* refuse(`${requested}: .env files are never posted.`)

        const root = rootOf(allowed.roots, file)

        if (Option.isNone(root)) {
          return yield* refuse(`${requested}: only files in your working directory, your tasks' directories or ${remote.tmp} can be posted.`)
        }

        const limit = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total)

        const data = yield* fleet.readFile(remote, root.value, path.relative(root.value, file), limit).pipe(
          Effect.catchTags({
            "Fleet.FileTooLarge": () =>
              refuse(
                `${requested} is too large. Discord allows ${Files.formatSize(MAX_FILE_BYTES)} per file and ` +
                  `${Files.formatSize(MAX_TOTAL_BYTES)} per message.`,
              ),
            "Fleet.ServerRequestError": () => refuse(`${requested}: could not read the file. Check that it exists.`),
          }),
        )

        const name = Files.uniqueName(taken, Files.safeName(path.basename(file)))

        total += data.byteLength
        uploads.push({ name, data, contentType: Files.typeOf(name) })
      }

      return uploads
    })

    return Service.of({ load })
  }),
)

export * as Uploads from "./Uploads.ts"
