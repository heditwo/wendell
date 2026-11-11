import path from "node:path"

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

/** A file name that is safe in a path and in a prompt: letters, digits, dots, dashes and underscores. */
export const safeName = (name: string) => {
  const cleaned = name
    .normalize("NFKC")
    .replaceAll(/[^A-Za-z0-9._-]+/g, "_")
    .replaceAll(/^[._-]+/g, "")
    .slice(-MAX_NAME)

  return cleaned === "" ? "file" : cleaned
}

/** `name`, or `2-name`, `3-name`… when it is already in `taken`. Adds the result to `taken`. */
export const uniqueName = (taken: Set<string>, name: string) => {
  let unique = name

  for (let index = 2; taken.has(unique); index += 1) unique = `${index}-${name}`

  taken.add(unique)

  return unique
}

export const typeOf = (name: string, declared?: string) => {
  const base = declared?.split(";")[0]?.trim().toLowerCase()

  if (base !== undefined && base !== "") return base

  return TYPES_BY_EXTENSION.get(path.extname(name).toLowerCase()) ?? "application/octet-stream"
}

/** Images that the model can see: PNG, JPEG, GIF and WebP. */
export const isImage = (type: string) => IMAGE_TYPES.has(type)

export const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`

  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export * as Files from "./Files.ts"
