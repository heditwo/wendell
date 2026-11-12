import { AbsolutePath } from "@opencode/client/effect"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import path from "node:path"
import { Fleet } from "../opencode/Fleet.ts"
import { Files } from "../shared/Files.ts"
import { Inbound } from "./Inbound.ts"

/** Larger attachments are not downloaded. */
export const MAX_BYTES = 25 * 1024 * 1024

export interface Interface {
  /** Saves a message's attachments in `directory/attachments/<message id>/` on the server. A file that cannot be saved becomes `Skipped`. */
  readonly save: (
    remote: Fleet.Remote,
    directory: AbsolutePath,
    message: Inbound.Message,
  ) => Effect.Effect<ReadonlyArray<Inbound.FileNote>>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Attachments") {}

interface Planned {
  readonly attachment: Inbound.Attachment
  readonly note: Inbound.FileNote
}

const planned = (directory: string, message: Inbound.Message): ReadonlyArray<Planned> => {
  const taken = new Set<string>()

  return message.attachments.map((attachment): Planned => {
    const name = Files.uniqueName(taken, Files.safeName(attachment.name))

    if (attachment.size > MAX_BYTES) {
      return {
        attachment,
        note: Inbound.FileNote.Skipped({
          name,
          size: attachment.size,
          reason: `larger than the ${Files.formatSize(MAX_BYTES)} limit, not downloaded`,
        }),
      }
    }

    const type = Files.typeOf(name, Option.getOrUndefined(attachment.contentType))

    return {
      attachment,
      note: Inbound.FileNote.Saved({
        name,
        type,
        size: attachment.size,
        path: path.join(directory, "attachments", message.id, name),
        image: Files.isImage(type),
      }),
    }
  })
}

/** Where each attachment goes and whether it is too large, before anything is downloaded. */
export const plan = (directory: string, message: Inbound.Message) => planned(directory, message).map(({ note }) => note)

/** The saved images, which go to the model with the prompt. */
export const images = (notes: ReadonlyArray<Inbound.FileNote>) =>
  notes.flatMap((note) => (Inbound.FileNote.$is("Saved")(note) && note.image ? [AbsolutePath.make(note.path)] : []))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fleet = yield* Fleet.Service
    const http = yield* HttpClient.HttpClient

    const download = Effect.fn("Attachments.download")(function* (attachment: Inbound.Attachment) {
      const response = yield* http.execute(HttpClientRequest.get(attachment.url)).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk))

      return new Uint8Array(yield* response.arrayBuffer)
    })

    const saveOne = (remote: Fleet.Remote, attachment: Inbound.Attachment, note: Inbound.FileNote) =>
      Inbound.FileNote.$match(note, {
        Skipped: (skipped) => Effect.succeed<Inbound.FileNote>(skipped),
        Saved: (saved) =>
          download(attachment).pipe(
            Effect.flatMap((data) =>
              data.byteLength > MAX_BYTES
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

    const save = Effect.fn("Attachments.save")(function* (
      remote: Fleet.Remote,
      directory: AbsolutePath,
      message: Inbound.Message,
    ) {
      return yield* Effect.forEach(planned(directory, message), ({ attachment, note }) => saveOne(remote, attachment, note), {
        concurrency: 4,
      })
    })

    return Service.of({ save })
  }),
)

export * as Attachments from "./Attachments.ts"
