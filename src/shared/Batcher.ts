import { Duration, Stream } from "effect"

export interface Options<A> {
  readonly max: number
  /** How long the batch may still wait after this item arrived. The earliest deadline of a batch wins. */
  readonly windowOf: (item: A) => Duration.Duration
}

/** Groups a stream into batches. A batch ends at its earliest deadline, or when it has `max` items. */
export const batches =
  <A>(options: Options<A>) =>
  (stream: Stream.Stream<A>): Stream.Stream<ReadonlyArray<A>> =>
    // Placeholder: a fixed window. The voice agent replaces it with the deadline of `windowOf`.
    stream.pipe(Stream.groupedWithin(options.max, Duration.millis(600)))

export * as Batcher from "./Batcher.ts"
