/**
 * Spec 5 ticket 05: a terminal's output masked with the Thread's values through the shared
 * {@link makeHeldText}; snapshots masked whole ({@link maskWhole}). Values that cannot be read
 * show {@link HIDDEN_OUTPUT} instead.
 */
import type { TerminalAttachStreamEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import { maskWhole } from "@t3tools/shared/secretMasking";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { HIDDEN_OUTPUT, makeHeldText } from "./heldText.ts";
import type * as SecretMasker from "./SecretMasker.ts";

export const maskTerminalSnapshot = (
  masker: SecretMasker.ThreadMasker,
  snapshot: TerminalSessionSnapshot,
): TerminalSessionSnapshot => {
  const history = maskWhole(masker, snapshot.history, { cutAtStart: true });
  return history === snapshot.history ? snapshot : { ...snapshot, history };
};

/** A snapshot whose values could not be read: its history is not shown. */
export const hiddenTerminalSnapshot = (snapshot: TerminalSessionSnapshot) => ({
  ...snapshot,
  history: HIDDEN_OUTPUT,
});

type Output = Extract<TerminalAttachStreamEvent, { readonly type: "output" }>;

/** The stream a client receives, masked with the Thread's values at each event. */
export const maskTerminalStream = <E, R>(
  masker: SecretMasker.SecretMasker["Service"],
  threadId: string,
  source: Stream.Stream<TerminalAttachStreamEvent, E, R>,
): Stream.Stream<TerminalAttachStreamEvent, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<TerminalAttachStreamEvent, E | Cause.Done>();
      // Events go out in order: one at a time.
      const order = yield* Semaphore.make(1);
      const held = yield* makeHeldText<Output>((data, event) =>
        Queue.offer(output, { ...event, data }).pipe(Effect.asVoid),
      );
      let hidden = false;

      const handle = (event: TerminalAttachStreamEvent) =>
        order.withPermits(1)(
          Effect.gen(function* () {
            const found = yield* Effect.option(masker.forThread(threadId));
            if (found._tag === "None") {
              // Fails closed: the text is replaced, once, until the values can be read again.
              if (event.type === "output") {
                if (!hidden) yield* Queue.offer(output, { ...event, data: `${HIDDEN_OUTPUT}\r\n` });
              } else if (event.type === "snapshot" || event.type === "restarted") {
                yield* Queue.offer(output, {
                  ...event,
                  snapshot: hiddenTerminalSnapshot(event.snapshot),
                });
              } else if (event.type === "error") {
                yield* Queue.offer(output, { ...event, message: HIDDEN_OUTPUT });
              } else {
                yield* Queue.offer(output, event);
              }
              hidden = true;
              return;
            }
            hidden = false;
            const threadMasker = found.value;
            switch (event.type) {
              case "output":
                return yield* held.push(threadMasker, event.data, event);
              case "snapshot":
              case "restarted":
                // What was held goes first (a start of a value as `[NAME]`); then the screen is
                // the snapshot, whose end a later frame may continue.
                yield* held.flush;
                yield* held.seed(threadMasker, event.snapshot.history);
                yield* Queue.offer(output, {
                  ...event,
                  snapshot: maskTerminalSnapshot(threadMasker, event.snapshot),
                });
                return;
              case "error":
                yield* held.flush;
                yield* Queue.offer(output, { ...event, message: threadMasker.mask(event.message) });
                return;
              default:
                yield* held.flush;
                yield* Queue.offer(output, event);
            }
          }),
        );

      yield* source.pipe(
        Stream.runForEach(handle),
        Effect.exit,
        Effect.flatMap((exit) =>
          order.withPermits(1)(
            Effect.gen(function* () {
              yield* held.flush;
              if (Exit.isFailure(exit)) yield* Queue.failCause(output, exit.cause);
              else yield* Queue.end(output);
            }),
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      return Stream.fromQueue(output);
    }),
  );
