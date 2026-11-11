import { Schema } from "effect"

export const MAX_EMBEDS = 10
export const MAX_TOTAL_CHARACTERS = 6000
const MAX_FIELDS = 25

const text = (max: number, description: string) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max)).annotate({ description })

const Url = Schema.String.check(
  Schema.isPattern(/^(https?:\/\/|attachment:\/\/)\S+$/, { message: "Use an http(s) URL or attachment://<file name>" }),
).annotate({ description: "An http(s) URL, or attachment://<file name> for a file in `files`." })

const Image = Schema.Struct({ url: Url })

export const Field = Schema.Struct({
  name: text(256, "Field name. At most 256 characters."),
  value: text(1024, "Field value. At most 1024 characters."),
  inline: Schema.optional(Schema.Boolean),
})

export interface Field extends Schema.Schema.Type<typeof Field> {}

export const Embed = Schema.Struct({
  title: Schema.optional(text(256, "At most 256 characters.")),
  description: Schema.optional(text(4096, "Discord markdown. At most 4096 characters.")),
  url: Schema.optional(Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/))).annotate({
    description: "Link for the title.",
  }),
  color: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffffff }))).annotate({
    description: "RGB color as an integer, for example 5793266 for #5865F2.",
  }),
  fields: Schema.optional(Schema.Array(Field).check(Schema.isMaxLength(MAX_FIELDS))),
  image: Schema.optional(Image),
  thumbnail: Schema.optional(Image),
  footer: Schema.optional(Schema.Struct({ text: text(2048, "At most 2048 characters.") })),
})

export interface Embed extends Schema.Schema.Type<typeof Embed> {}

/** Characters that count against Discord's limit of 6000 per message. */
export const characters = (embed: Embed) =>
  (embed.title?.length ?? 0) +
  (embed.description?.length ?? 0) +
  (embed.footer?.text.length ?? 0) +
  (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0)

export const List = Schema.Array(Embed).check(
  Schema.isMaxLength(MAX_EMBEDS),
  Schema.makeFilter((embeds) => {
    const total = embeds.reduce((sum, embed) => sum + characters(embed), 0)

    return total <= MAX_TOTAL_CHARACTERS || `The embeds have ${total} characters; Discord allows ${MAX_TOTAL_CHARACTERS} in total.`
  }),
  Schema.makeFilter((embeds) =>
    embeds.every((embed) => characters(embed) > 0 || embed.image !== undefined || embed.thumbnail !== undefined) ||
    "Every embed needs a title, description, field, footer or image.",
  ),
)

/** The file names that the embeds use as `attachment://<name>`. */
export const attachmentNames = (embeds: ReadonlyArray<Embed>) =>
  embeds.flatMap((embed) =>
    [embed.image?.url, embed.thumbnail?.url].flatMap((url) =>
      url !== undefined && url.startsWith("attachment://") ? [url.slice("attachment://".length)] : [],
    ),
  )

export * as Embeds from "./Embeds.ts"
