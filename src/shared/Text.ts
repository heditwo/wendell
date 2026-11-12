/** Escapes untrusted text for the XML-like blocks in prompts. */
export const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** Escapes untrusted text for an attribute value in prompts. */
export const attribute = (text: string) => escape(text).replaceAll('"', "&quot;")

export const truncate = (text: string, length: number) => (text.length <= length ? text : `${text.slice(0, length - 1)}…`)

export const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10)

export * as Text from "./Text.ts"
