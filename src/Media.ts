import { AbsolutePath } from "@opencode/client/effect"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import path from "node:path"
import type { Discord } from "./Discord.ts"
import { Fleet } from "./Fleet.ts"
import { Inbound } from "./Inbound.ts"
import { Policy } from "./Policy.ts"

/** Larger attachments are not downloaded. */
export const MAX_INCOMING_BYTES = 25 * 1024 * 1024

/** Discord's limits for servers without boosts. */
export const MAX_OUTGOING_FILES = 10
export const MAX_OUTGOING_FILE_BYTES = 20 * 1024 * 1024
export const MAX_OUTGOING_TOTAL_BYTES = 25 * 1024 * 1024

const MAX_NAME = 100

const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const TYPES_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".json", "application/json"],
  [".csv", "text/csv"],
  [".zip", "application/zip"],
  [".svg", "image/svg+xml"],
  [".html", "text/html"],
  [".mp4", "video/mp4"],
  [".mp3", "audio/mpeg"],
])

export interface Interface {
  /** Saves a message's attachments in `directory/attachments/<message id>/` on the server. Never fails. */
  readonly saveIncoming: (
    remote: Fleet.Remote,
    directory: AbsolutePath,
    message: Inbound.Message,
  ) => Effect.Effect<ReadonlyArray<Inbound.FileNote>>
  /**
   * Reads files from the server for a Discord message. Relative paths start at `directory`. Every file must be
   * inside one of `roots`, and `.env` files are refused.
   */
  readonly loadOutgoing: (
    remote: Fleet.Remote,
    directory: AbsolutePath,
    roots: ReadonlyArray<AbsolutePath>,
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Discord.Upload>, FileRefused>
}

export class FileRefused extends Schema.TaggedError<FileRefused>()("Media.FileRefused", {
  message: Schema.String,
}) {}

export class Service extends Context.Service<Service, Interface>()("wendell/Media") {}

/** A file name that is safe in a path and in a prompt: letters, digits, dots, dashes and underscores. */
export const safeName = (name: string) => {
  const cleaned = name
    .normalize("NFKC")
    .replaceAll(/[^A-Za-z0-9._-]+/g, "_")
    .replaceAll(/^[._-]+/g, "")
    .slice(-MAX_NAME)

  return cleaned === "" ? "file" : cleaned
}

export const typeOf = (name: string, declared?: string) => {
  const base = declared?.split(";")[0]?.trim().toLowerCase()

  if (base !== undefined && base !== "") return base

  return TYPES_BY_EXTENSION.get(path.extname(name).toLowerCase()) ?? "application/octet-stream"
}

export const isImage = (type: string) => IMAGE_TYPES.has(type)

interface Planned {
  readonly attachment: Inbound.Attachment
  readonly note: Inbound.FileNote
}

const planned = (directory: string, message: Inbound.Message): ReadonlyArray<Planned> => {
  const taken = new Set<string>()

  return message.attachments.map((attachment): Planned => {
    const name = safeName(attachment.name)
    let unique = name

    for (let index = 2; taken.has(unique); index += 1) unique = `${index}-${name}`

    taken.add(unique)

    if (attachment.size > MAX_INCOMING_BYTES) {
      return {
        attachment,
        note: Inbound.FileNote.Skipped({
          name: unique,
          size: attachment.size,
          reason: `larger than the ${Inbound.formatSize(MAX_INCOMING_BYTES)} limit, not downloaded`,
        }),
      }
    }

    const type = typeOf(unique, Option.getOrUndefined(attachment.contentType))

    return {
      attachment,
      note: Inbound.FileNote.Saved({
        name: unique,
        type,
        size: attachment.size,
        path: path.join(directory, "attachments", message.id, unique),
        image: isImage(type),
      }),
    }
  })
}

/** Where each attachment goes and whether it is too large, before anything is downloaded. */
export const plan = (directory: string, message: Inbound.Message) => planned(directory, message).map(({ note }) => note)

export const images = (notes: ReadonlyArray<Inbound.FileNote>) =>
  notes.flatMap((note) => (Inbound.FileNote.$is("Saved")(note) && note.image ? [AbsolutePath.make(note.path)] : []))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fleet = yield* Fleet.Service
    const http = yield* HttpClient.HttpClient

    const download = Effect.fn("Media.download")(function* (attachment: Inbound.Attachment) {
      const response = yield* http.execute(HttpClientRequest.get(attachment.url)).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))

      return new Uint8Array(yield* response.arrayBuffer)
    })

    const saveOne = (remote: Fleet.Remote, attachment: Inbound.Attachment, note: Inbound.FileNote) =>
      Inbound.FileNote.$match(note, {
        Skipped: (skipped) => Effect.succeed<Inbound.FileNote>(skipped),
        Saved: (saved) =>
          download(attachment).pipe(
            Effect.flatMap((data) =>
              data.byteLength > MAX_INCOMING_BYTES
                ? Effect.succeed<Inbound.FileNote>(
                    Inbound.FileNote.Skipped({ name: saved.name, size: data.byteLength, reason: "too large, not saved" }),
                  )
                : fleet
                    .writeFile(remote, AbsolutePath.make(saved.path), data)
                    .pipe(Effect.as<Inbound.FileNote>(Inbound.FileNote.Saved({ ...saved, size: data.byteLength }))),
            ),
            Effect.catch((cause) =>
              Effect.logWarning("Could not save an attachment", { server: remote.name, attachment: attachment.id, cause }).pipe(
                Effect.as<Inbound.FileNote>(
                  Inbound.FileNote.Skipped({ name: saved.name, size: saved.size, reason: "could not be downloaded" }),
                ),
              ),
            ),
          ),
      })

    const saveIncoming = Effect.fn("Media.saveIncoming")(function* (
      remote: Fleet.Remote,
      directory: AbsolutePath,
      message: Inbound.Message,
    ) {
      return yield* Effect.forEach(planned(directory, message), ({ attachment, note }) => saveOne(remote, attachment, note), {
        concurrency: 4,
      })
    })

    const refuse = (message: string) => Effect.fail(new FileRefused({ message }))

    const rootOf = (roots: ReadonlyArray<AbsolutePath>, file: string) =>
      Option.fromUndefinedOr(roots.find((root) => file === root || file.startsWith(`${root.replace(/\/+$/, "")}/`)))

    const loadOutgoing = Effect.fn("Media.loadOutgoing")(function* (
      remote: Fleet.Remote,
      directory: AbsolutePath,
      roots: ReadonlyArray<AbsolutePath>,
      paths: ReadonlyArray<string>,
    ) {
      if (paths.length > MAX_OUTGOING_FILES) return yield* refuse(`Discord allows at most ${MAX_OUTGOING_FILES} files per message.`)

      const uploads = new Array<Discord.Upload>()
      const taken = new Set<string>()
      let total = 0

      for (const requested of paths) {
        const file = path.resolve(directory, requested)

        if (Policy.isSecretFile(file)) return yield* refuse(`${requested}: .env files are never posted.`)

        const root = rootOf(roots, file)

        if (Option.isNone(root)) {
          return yield* refuse(`${requested}: only files in your working directory, your tasks' directories or ${remote.tmp} can be posted.`)
        }

        const limit = Math.min(MAX_OUTGOING_FILE_BYTES, MAX_OUTGOING_TOTAL_BYTES - total)

        const data = yield* fleet.readFile(remote, root.value, path.relative(root.value, file), limit).pipe(
          Effect.catchTags({
            "Fleet.FileTooLarge": () =>
              refuse(
                `${requested} is too large. Discord allows ${Inbound.formatSize(MAX_OUTGOING_FILE_BYTES)} per file and ` +
                  `${Inbound.formatSize(MAX_OUTGOING_TOTAL_BYTES)} per message.`,
              ),
            "Fleet.ServerRequestError": () => refuse(`${requested}: could not read the file. Check that it exists.`),
          }),
        )

        const name = safeName(path.basename(file))
        let unique = name

        for (let index = 2; taken.has(unique); index += 1) unique = `${index}-${name}`

        taken.add(unique)
        total += data.byteLength
        uploads.push({ name: unique, data, contentType: typeOf(unique) })
      }

      return uploads
    })

    return Service.of({ saveIncoming, loadOutgoing })
  }),
)

export * as Media from "./Media.ts"
