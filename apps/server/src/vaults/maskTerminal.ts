/**
 * Spec 5 ticket 05: a terminal's output, masked on the Hub before a client sees it. Output whose
 * end could be the start of a secret value waits for the next chunk (at most
 * {@link TERMINAL_SECRET_HOLD_MS}), and the two go out as one: a value split between two frames is
 * still masked. Snapshots (a terminal's history) are masked whole.
 */
import type { TerminalAttachStreamEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type * as SecretMasker from "./SecretMasker.ts";

const TERMINAL_SECRET_HOLD_MS = 150;
/** Output held beyond this is masked and sent as it is. */
const MAX_HELD_CHARS = 128 * 1024;

export const maskTerminalSnapshot = (
  masker: SecretMasker.ThreadMasker,
  snapshot: TerminalSessionSnapshot,
): TerminalSessionSnapshot => {
  if (masker.isEmpty) return snapshot;
  const history = masker.mask(snapshot.history);
  return history === snapshot.history ? snapshot : { ...snapshot, history };
};

type Output = Extract<TerminalAttachStreamEvent, { readonly type: "output" }>;

const maskEvent = (
  masker: SecretMasker.ThreadMasker,
  event: TerminalAttachStreamEvent,
): TerminalAttachStreamEvent => {
  switch (event.type) {
    case "snapshot":
    case "restarted":
      return { ...event, snapshot: maskTerminalSnapshot(masker, event.snapshot) };
    case "output":
      return { ...event, data: masker.mask(event.data) };
    case "error":
      return { ...event, message: masker.mask(event.message) };
    default:
      return event;
  }
};

/** The stream a client receives: every event masked with the Thread's masker at that moment. */
export const maskTerminalStream = <E, R>(
  masker: SecretMasker.SecretMasker["Service"],
  threadId: string,
  source: Stream.Stream<TerminalAttachStreamEvent, E, R>,
): Stream.Stream<TerminalAttachStreamEvent, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const output = yield* Queue.unbounded<TerminalAttachStreamEvent, E | Cause.Done>();
      const mutex = yield* Semaphore.make(1);
      let held: { readonly event: Output; readonly masker: SecretMasker.ThreadMasker } | undefined;
      let timer: Fiber.Fiber<void, never> | undefined;
      let generation = 0;

      const flushHeld = Effect.suspend(() => {
        const pending = held;
        held = undefined;
        generation += 1;
        return pending === undefined
          ? Effect.void
          : Queue.offer(output, maskEvent(pending.masker, pending.event)).pipe(Effect.asVoid);
      });
      const cancelTimer = Effect.suspend(() => {
        const fiber = timer;
        timer = undefined;
        return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
      });

      const handle = (event: TerminalAttachStreamEvent) =>
        mutex.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* masker.forThread(threadId);
            if (event.type !== "output") {
              yield* cancelTimer;
              yield* flushHeld;
              yield* Queue.offer(output, maskEvent(current, event));
              return;
            }
            // The later frame carries the pair: its sequence covers both.
            const merged: Output =
              held === undefined ? event : { ...event, data: held.event.data + event.data };
            yield* cancelTimer;
            held = undefined;
            if (
              !current.isEmpty &&
              merged.data.length <= MAX_HELD_CHARS &&
              current.pendingSuffix(merged.data) > 0
            ) {
              held = { event: merged, masker: current };
              const mine = ++generation;
              timer = yield* Effect.forkIn(
                Effect.sleep(TERMINAL_SECRET_HOLD_MS).pipe(
                  Effect.andThen(
                    mutex.withPermits(1)(
                      Effect.suspend(() => (mine === generation ? flushHeld : Effect.void)),
                    ),
                  ),
                ),
                scope,
              );
              return;
            }
            generation += 1;
            yield* Queue.offer(output, maskEvent(current, merged));
          }),
        );

      yield* source.pipe(
        Stream.runForEach(handle),
        Effect.exit,
        Effect.flatMap((exit) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              yield* cancelTimer;
              yield* flushHeld;
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
