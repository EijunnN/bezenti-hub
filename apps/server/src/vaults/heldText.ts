/**
 * Spec 5 ticket 05: the one way text in pieces (terminal frames, command output) is masked: a
 * {@link SecretStreamGuard} for the stream's life, plus the wait for a value's rest. A start of a
 * value sent after the wait shows as `[NAME]`, never raw.
 */
import { type SecretPatterns, SecretStreamGuard } from "@t3tools/shared/secretMasking";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** How long text that could end in the start of a value waits for the rest. */
const HOLD_MS = 150;
/** Text held beyond this goes out at once (its trailing start as `[NAME]`). */
const MAX_HELD_CHARS = 128 * 1024;

/** Shown instead of a stream's text when the values to hide in it could not be read. */
export const HIDDEN_OUTPUT = "[output hidden: secrets could not be loaded]";

export interface HeldText<C> {
  /** A piece, masked with `patterns` (the stream's values now); `context` goes out with it. */
  readonly push: (patterns: SecretPatterns, chunk: string, context: C) => Effect.Effect<void>;
  /** Sends what is held now (the stream ends, or something else must go out after it). */
  readonly flush: Effect.Effect<void>;
  /** The screen was reset to `text` (a snapshot): what is held is dropped, `text` is in view. */
  readonly seed: (patterns: SecretPatterns, text: string) => Effect.Effect<void>;
}

/** A stream's masking: `emit` sends masked text, with the context of the latest piece in it. */
export const makeHeldText = Effect.fn("SecretMasker.makeHeldText")(function* <C>(
  emit: (text: string, context: C) => Effect.Effect<void>,
) {
  const mutex = yield* Semaphore.make(1);
  let guard: SecretStreamGuard | undefined;
  let heldContext: C | undefined;
  let generation = 0;

  const guardFor = (patterns: SecretPatterns) => {
    if (guard === undefined) guard = new SecretStreamGuard(patterns);
    else guard.setPatterns(patterns);
    return guard;
  };

  const release = Effect.suspend(() => {
    generation += 1;
    const context = heldContext;
    heldContext = undefined;
    if (guard === undefined || !guard.holding || context === undefined) return Effect.void;
    return emit(guard.release(), context);
  });

  const push = (patterns: SecretPatterns, chunk: string, context: C) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        generation += 1;
        const pushed = guardFor(patterns).push(chunk, MAX_HELD_CHARS);
        heldContext = undefined;
        if (pushed.text.length > 0) yield* emit(pushed.text, context);
        if (!pushed.hold) return;
        heldContext = context;
        const mine = generation;
        yield* Effect.sleep(HOLD_MS).pipe(
          Effect.andThen(
            mutex.withPermits(1)(
              Effect.suspend(() => (mine === generation ? release : Effect.void)),
            ),
          ),
          Effect.forkDetach,
        );
      }),
    );

  const seed = (patterns: SecretPatterns, text: string) =>
    mutex.withPermits(1)(
      Effect.sync(() => {
        generation += 1;
        heldContext = undefined;
        guardFor(patterns).seed(text);
      }),
    );

  return { push, flush: mutex.withPermits(1)(release), seed } satisfies HeldText<C>;
});
