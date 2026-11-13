/**
 * Spec 5 ticket 05: a terminal's output, masked on the Hub before a client sees it, through the
 * shared {@link SecretStreamGuard} (a value split between frames is masked whole, or its
 * continuation is). Snapshots are masked whole, without what is left of a value cut at the start.
 */
import type { TerminalAttachStreamEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import { SecretStreamGuard } from "@t3tools/shared/secretMasking";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type * as SecretMasker from "./SecretMasker.ts";

/** How long output that could end in the start of a value waits for the rest. */
const HOLD_MS = 150;
/** Output held beyond this is masked and sent as it is. */
const MAX_HELD_CHARS = 128 * 1024;

/** Text cut before its start (a trimmed history) masked, without a value's leftover end. */
const maskCutText = (masker: SecretMasker.ThreadMasker, text: string): string =>
  masker.isEmpty ? text : masker.mask(text.slice(masker.pendingPrefix(text)));

export const maskTerminalSnapshot = (
  masker: SecretMasker.ThreadMasker,
  snapshot: TerminalSessionSnapshot,
): TerminalSessionSnapshot => {
  const history = maskCutText(masker, snapshot.history);
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
    case "error":
      return { ...event, message: masker.mask(event.message) };
    default:
      return event;
  }
};

/**
 * The stream a client receives, masked with the Thread's masker at each event. A masker that
 * cannot be read ends the stream (nothing unmasked is sent).
 */
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
      let current:
        | { readonly masker: SecretMasker.ThreadMasker; readonly guard: SecretStreamGuard }
        | undefined;
      let heldEvent: Output | undefined;
      let timer: Fiber.Fiber<void, never> | undefined;
      let generation = 0;

      const release = Effect.suspend(() => {
        generation += 1;
        const held = heldEvent;
        heldEvent = undefined;
        if (current === undefined || !current.guard.holding || held === undefined) {
          return Effect.void;
        }
        return Queue.offer(output, { ...held, data: current.guard.release() }).pipe(Effect.asVoid);
      });
      const cancelTimer = Effect.suspend(() => {
        const fiber = timer;
        timer = undefined;
        return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
      });

      const handle = (event: TerminalAttachStreamEvent) =>
        mutex.withPermits(1)(
          Effect.gen(function* () {
            const threadMasker = yield* Effect.orDie(masker.forThread(threadId));
            yield* cancelTimer;
            // A new set of values, or a reset of the screen: what was held goes, a new guard starts.
            if (current?.masker !== threadMasker || event.type !== "output") {
              yield* release;
              current = { masker: threadMasker, guard: new SecretStreamGuard(threadMasker) };
            }
            if (event.type !== "output") {
              yield* Queue.offer(output, maskEvent(threadMasker, event));
              return;
            }
            const pushed = current.guard.push(event.data, MAX_HELD_CHARS);
            if (pushed.text.length > 0) yield* Queue.offer(output, { ...event, data: pushed.text });
            if (!pushed.hold) return;
            heldEvent = event;
            const mine = ++generation;
            timer = yield* Effect.forkIn(
              Effect.sleep(HOLD_MS).pipe(
                Effect.andThen(
                  mutex.withPermits(1)(
                    Effect.suspend(() => (mine === generation ? release : Effect.void)),
                  ),
                ),
              ),
              scope,
            );
          }),
        );

      yield* source.pipe(
        Stream.runForEach(handle),
        Effect.exit,
        Effect.flatMap((exit) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              yield* cancelTimer;
              yield* release;
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
