import { Clock, Duration, Effect, Option, Queue, Stream } from "effect"

export interface Options<A> {
  readonly max: number
  /** How long the batch may still wait after this item arrived. The earliest deadline of a batch wins. */
  readonly windowOf: (item: A) => Duration.Duration
}

interface Arrival<A> {
  readonly item: A
  readonly deadline: number
}

/**
 * Groups a stream into batches. A batch ends at its earliest deadline, or when it has `max` items. At the deadline,
 * items that already wait join the batch. The last batch is emitted when the stream ends.
 */
export const batches =
  <A>(options: Options<A>) =>
  (stream: Stream.Stream<A>): Stream.Stream<ReadonlyArray<A>> =>
    Stream.callback<ReadonlyArray<A>>((out) =>
      Effect.gen(function* () {
        const max = Math.max(1, Math.floor(options.max))
        const arrivals = yield* Queue.unbounded<Option.Option<Arrival<A>>>()

        const arrive = (item: A) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => Queue.offer(arrivals, Option.some({ item, deadline: now + Duration.toMillis(options.windowOf(item)) }))),
          )

        yield* stream.pipe(
          Stream.runForEach(arrive),
          Effect.andThen(Queue.offer(arrivals, Option.none())),
          Effect.forkScoped,
        )

        const next = Effect.fnUntraced(function* (deadline: number) {
          const remaining = deadline - (yield* Clock.currentTimeMillis)

          if (remaining <= 0) return yield* Queue.poll(arrivals)

          return yield* Queue.take(arrivals).pipe(Effect.timeoutOption(remaining))
        })

        let ended = false

        while (!ended) {
          const first = yield* Queue.take(arrivals)

          if (Option.isNone(first)) break

          const batch = [first.value.item]
          let deadline = first.value.deadline

          while (batch.length < max) {
            const arrival = yield* next(deadline)

            if (Option.isNone(arrival)) break

            if (Option.isNone(arrival.value)) {
              ended = true
              break
            }

            batch.push(arrival.value.value.item)
            deadline = Math.min(deadline, arrival.value.value.deadline)
          }

          yield* Queue.offer(out, batch)
        }

        yield* Queue.end(out)
      }),
    )

export * as Batcher from "./Batcher.ts"
