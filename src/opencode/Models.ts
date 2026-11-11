import { type AbsolutePath, Model } from "@opencode/client/effect"
import { Cache, Context, Duration, Effect, FileSystem, Layer, Option, Ref, Schema, Semaphore } from "effect"
import path from "node:path"
import { Fleet } from "./Fleet.ts"
import { ChannelId, ServerName } from "../shared/Ids.ts"
import { Settings } from "../config/Settings.ts"
import { WendellConfig } from "../config/WendellConfig.ts"

const CATALOG_TTL = Duration.minutes(5)
const SUGGESTIONS = 5

const Override = Schema.Struct({
  server: ServerName,
  model: Schema.String,
})

const StoredFile = Schema.Struct({
  defaults: Schema.Record(Schema.String, Schema.String).check(Schema.isPropertyNames(ServerName)),
  conversations: Schema.Record(Schema.String, Override).check(Schema.isPropertyNames(ChannelId)),
})

interface StoredFile extends Schema.Schema.Type<typeof StoredFile> {}

/** A model that the server offers: `id` is "provider/model" with an optional "#variant". */
export interface Resolved {
  readonly ref: Model.Ref
  readonly id: string
  readonly name: string
}

export class ModelsFileError extends Schema.TaggedError<ModelsFileError>()("Models.ModelsFileError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export class CatalogError extends Schema.TaggedError<CatalogError>()("Models.CatalogError", {
  server: Schema.String,
  cause: Schema.Defect(),
}) {}

export class NoAllowedModel extends Schema.TaggedError<NoAllowedModel>()("Models.NoAllowedModel", {
  server: Schema.String,
  message: Schema.String,
}) {}

export class UnknownModel extends Schema.TaggedError<UnknownModel>()("Models.UnknownModel", {
  message: Schema.String,
}) {}

export interface Interface {
  /** Enabled chat models of providers that are not blocked, cached for a few minutes. */
  readonly catalog: (remote: Fleet.Remote, directory: AbsolutePath) => Effect.Effect<ReadonlyArray<Model.Info>, CatalogError>
  readonly resolve: (
    remote: Fleet.Remote,
    directory: AbsolutePath,
    input: string,
  ) => Effect.Effect<Resolved, CatalogError | UnknownModel>
  /** Models that match every word of the query. Models of `preferred` providers come first, in that order. */
  readonly search: (
    remote: Fleet.Remote,
    directory: AbsolutePath,
    query: string,
    limit: number,
    preferred: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Model.Info>, CatalogError>
  /**
   * The model for a conversation: its own choice, then the stored server default, then
   * `servers.<name>.model`. Models of blocked providers are skipped.
   */
  readonly chosen: (remote: Fleet.Remote, channelId: ChannelId) => Effect.Effect<Option.Option<string>>
  /** `chosen` as a reference. None means the agent's default, which is only allowed when no provider is blocked. */
  readonly pick: (
    remote: Fleet.Remote,
    channelId: ChannelId,
  ) => Effect.Effect<Option.Option<Model.Ref>, NoAllowedModel | UnknownModel>
  /** The stored default, then `servers.<name>.model` in wendell.json, without blocked providers. */
  readonly defaultFor: (remote: Fleet.Remote) => Effect.Effect<Option.Option<string>>
  readonly setDefault: (remote: Fleet.Remote, model: string) => Effect.Effect<void, ModelsFileError>
  readonly setConversation: (remote: Fleet.Remote, channelId: ChannelId, model: string) => Effect.Effect<void, ModelsFileError>
}

export class Service extends Context.Service<Service, Interface>()("wendell/Models") {}

export const key = (model: Model.Info) => `${model.providerID}/${model.id}`

export const parse = (input: string) =>
  Effect.try({
    try: () => Model.Ref.parse(input.trim()),
    catch: () => new UnknownModel({ message: `"${input}" is not a model reference. Use "provider/model" with IDs that the server lists.` }),
  })

const tokens = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((token) => token !== "")

const haystack = (model: Model.Info) => `${key(model)} ${model.name}`.toLowerCase()

const score = (model: Model.Info, query: string) => {
  const text = haystack(model)
  const matched = tokens(query).filter((token) => text.includes(token)).length
  const exact = key(model) === query.trim().toLowerCase() || model.id === query.trim().toLowerCase() ? 100 : 0

  return matched + exact
}

/** Models that contain every word of the query, in catalog order. */
export const matching = (models: ReadonlyArray<Model.Info>, query: string) => {
  const words = tokens(query)

  return models.filter((model) => {
    const text = haystack(model)

    return words.every((word) => text.includes(word))
  })
}

const closest = (models: ReadonlyArray<Model.Info>, query: string) =>
  models
    .flatMap((model) => {
      const points = score(model, query)

      return points > 0 ? [{ model, points }] : []
    })
    .toSorted((left, right) => right.points - left.points)
    .slice(0, SUGGESTIONS)
    .map(({ model }) => key(model))

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredFile))
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(StoredFile))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* Settings.Service
    const fleet = yield* Fleet.Service
    const fs = yield* FileSystem.FileSystem
    const file = path.join(settings.dataDirectory, "models.json")
    const fileError = (cause: unknown) => new ModelsFileError({ path: file, cause })

    const initial = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return { defaults: {}, conversations: {} }

      return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeFile))
    }).pipe(Effect.mapError(fileError))

    const state = yield* Ref.make<StoredFile>(initial)
    const writes = yield* Semaphore.make(1)

    const persist = Effect.gen(function* () {
      const json = yield* encodeFile(yield* Ref.get(state))

      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, `${json}\n`)
    }).pipe(Effect.mapError(fileError), Semaphore.withPermits(writes, 1))

    const caches = new Map<ServerName, Cache.Cache<AbsolutePath, ReadonlyArray<Model.Info>, CatalogError>>()

    for (const remote of fleet.remotes) {
      caches.set(
        remote.name,
        yield* Cache.make({
          capacity: 64,
          timeToLive: CATALOG_TTL,
          lookup: (directory: AbsolutePath) =>
            remote.client.model.list({ location: { directory }, types: ["chat"] }).pipe(
              Effect.map(
                (page): ReadonlyArray<Model.Info> =>
                  page.data.filter((model) => model.enabled && !WendellConfig.isBlocked(remote.prefs, key(model))),
              ),
              Effect.mapError((cause) => new CatalogError({ server: remote.name, cause })),
            ),
        }),
      )
    }

    const catalog = Effect.fn("Models.catalog")(function* (remote: Fleet.Remote, directory: AbsolutePath) {
      const cache = caches.get(remote.name)

      if (cache === undefined) return yield* new CatalogError({ server: remote.name, cause: "Server is not connected." })

      return yield* Cache.get(cache, directory)
    })

    const resolve = Effect.fn("Models.resolve")(function* (remote: Fleet.Remote, directory: AbsolutePath, input: string) {
      const models = yield* catalog(remote, directory)

      const unknown = (what: string) => {
        const suggestions = closest(models, input)

        return new UnknownModel({
          message:
            suggestions.length === 0
              ? `${what} Use "provider/model".`
              : `${what} Close matches: ${suggestions.join(", ")}.`,
        })
      }

      if (!input.includes("/")) return yield* unknown(`"${input}" has no provider.`)

      if (WendellConfig.isBlocked(remote.prefs, input.trim())) {
        return yield* new UnknownModel({
          message: `Wendell must not use the provider "${WendellConfig.providerOf(input.trim())}" on ${remote.name}. Pick another provider.`,
        })
      }

      const ref = yield* parse(input)
      const found = models.find((model) => model.providerID === ref.providerID && model.id === ref.id)

      if (found === undefined) return yield* unknown(`${remote.name} has no enabled chat model "${ref.providerID}/${ref.id}".`)

      if (ref.variant !== undefined && !found.variants.some((variant) => variant.id === ref.variant)) {
        return yield* new UnknownModel({
          message: `${key(found)} has no variant "${ref.variant}". Variants: ${found.variants.map((variant) => variant.id).join(", ") || "none"}.`,
        })
      }

      const id = ref.variant === undefined ? key(found) : `${key(found)}#${ref.variant}`

      return { ref, id, name: ref.variant === undefined ? found.name : `${found.name} (${ref.variant})` }
    })

    const search = Effect.fn("Models.search")(function* (
      remote: Fleet.Remote,
      directory: AbsolutePath,
      query: string,
      limit: number,
      preferred: ReadonlyArray<string>,
    ) {
      const rank = (model: Model.Info) => {
        const index = preferred.indexOf(model.providerID)

        return index === -1 ? preferred.length : index
      }

      return matching(yield* catalog(remote, directory), query)
        .toSorted((left, right) => rank(left) - rank(right))
        .slice(0, limit)
    })

    const allowed = (remote: Fleet.Remote, candidates: ReadonlyArray<string | undefined>) =>
      Option.fromUndefinedOr(
        candidates.find(
          (candidate): candidate is string => candidate !== undefined && !WendellConfig.isBlocked(remote.prefs, candidate),
        ),
      )

    const defaultFor = Effect.fn("Models.defaultFor")(function* (remote: Fleet.Remote) {
      return allowed(remote, [(yield* Ref.get(state)).defaults[remote.name], remote.prefs.model])
    })

    const chosen = Effect.fn("Models.chosen")(function* (remote: Fleet.Remote, channelId: ChannelId) {
      const current = yield* Ref.get(state)
      const own = current.conversations[channelId]

      return allowed(remote, [
        own?.server === remote.name ? own.model : undefined,
        current.defaults[remote.name],
        remote.prefs.model,
      ])
    })

    const pick = Effect.fn("Models.pick")(function* (remote: Fleet.Remote, channelId: ChannelId) {
      const model = yield* chosen(remote, channelId)

      if (Option.isSome(model)) return Option.some(yield* parse(model.value))

      if ((remote.prefs.blockedProviders ?? []).length > 0) {
        return yield* new NoAllowedModel({
          server: remote.name,
          message:
            `No allowed model for ${remote.name}: the agent's default could use a blocked provider. ` +
            `Set servers.${remote.name}.model in wendell.json to a model of an allowed provider.`,
        })
      }

      return Option.none<Model.Ref>()
    })

    const setDefault = Effect.fn("Models.setDefault")(function* (remote: Fleet.Remote, model: string) {
      yield* Ref.update(state, (current) => ({ ...current, defaults: { ...current.defaults, [remote.name]: model } }))
      yield* persist
    })

    const setConversation = Effect.fn("Models.setConversation")(function* (
      remote: Fleet.Remote,
      channelId: ChannelId,
      model: string,
    ) {
      yield* Ref.update(state, (current) => ({
        ...current,
        conversations: { ...current.conversations, [channelId]: { server: remote.name, model } },
      }))
      yield* persist
    })

    return Service.of({ catalog, resolve, search, chosen, pick, defaultFor, setDefault, setConversation })
  }),
)

export * as Models from "./Models.ts"
