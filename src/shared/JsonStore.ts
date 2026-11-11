import { Effect, FileSystem, Ref, Schema, Semaphore } from "effect"
import path from "node:path"

export class StoreError extends Schema.TaggedError<StoreError>()("JsonStore.StoreError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A value kept in memory and written to one JSON file after every change. */
export interface JsonStore<A> {
  readonly get: Effect.Effect<A>
  readonly update: (change: (current: A) => A) => Effect.Effect<void, StoreError>
  readonly modify: <B>(change: (current: A) => readonly [B, A]) => Effect.Effect<B, StoreError>
}

const open = <A, I>(
  schema: Schema.Codec<A, I>,
  file: string,
  initial: A,
  onBroken: (error: StoreError) => Effect.Effect<A, StoreError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const json = Schema.fromJsonString(schema)
    const decode = Schema.decodeUnknownEffect(json)
    const encode = Schema.encodeEffect(json)
    const fail = (cause: unknown) => new StoreError({ path: file, cause })

    const stored = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return initial

      return yield* fs.readFileString(file).pipe(Effect.flatMap(decode))
    }).pipe(Effect.mapError(fail), Effect.catch(onBroken))

    const state = yield* Ref.make(stored)
    const writes = yield* Semaphore.make(1)

    // The file always gets the latest state, so concurrent changes cannot write an older one last.
    const persist = Effect.gen(function* () {
      const text = yield* encode(yield* Ref.get(state))

      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, `${text}\n`)
    }).pipe(Effect.mapError(fail), Semaphore.withPermits(writes, 1))

    const modify = <B>(change: (current: A) => readonly [B, A]) =>
      Ref.modify(state, change).pipe(Effect.tap(() => persist))

    const update = (change: (current: A) => A) => Ref.update(state, change).pipe(Effect.andThen(persist))

    return { get: Ref.get(state), update, modify } satisfies JsonStore<A>
  })

/**
 * Reads `file` with `schema`, or starts from `initial` when it does not exist. Fails when the file
 * cannot be read or decoded, so a broken file is never overwritten.
 */
export const make = <A, I>(schema: Schema.Codec<A, I>, file: string, initial: A) => open(schema, file, initial, Effect.fail)

/** Like `make`, but starts from `initial` when the file is broken. For state that is cheap to lose. */
export const makeOrReset = <A, I>(schema: Schema.Codec<A, I>, file: string, initial: A) =>
  open(schema, file, initial, (error) =>
    Effect.logWarning("Could not read a data file, starting empty", { path: error.path, cause: error.cause }).pipe(
      Effect.as(initial),
    ),
  )

export * as JsonStore from "./JsonStore.ts"
