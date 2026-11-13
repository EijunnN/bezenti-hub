/**
 * Spec 5 ticket 05: what a client watches of a Git action (hook output, progress, errors) is
 * masked with the asking User's own values (never with a Thread the client names: a client cannot
 * pick whose values mask). When they cannot be read, hook output shows `HIDDEN_OUTPUT` and errors
 * are replaced by it.
 */
import type { GitActionProgressEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { hideErrorText } from "@t3tools/shared/secretMasking";

import type * as GitManager from "../git/GitManager.ts";
import { HIDDEN_OUTPUT } from "./heldText.ts";
import type * as SecretMasker from "./SecretMasker.ts";

export const maskGitProgress = Effect.fnUntraced(function* (
  masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
  options: GitManager.GitRunStackedActionOptions | undefined,
) {
  const reporter = options?.progressReporter;
  if (reporter === undefined || Option.isNone(masker)) return options;
  const found = yield* Effect.option(masker.value.forViewer);
  return {
    ...options,
    progressReporter: {
      publish: (event: GitActionProgressEvent) =>
        Option.isSome(found)
          ? reporter.publish(found.value.maskDeep(event))
          : reporter.publish(
              event.kind === "hook_output" ? { ...event, text: HIDDEN_OUTPUT } : event,
            ),
    },
  } satisfies GitManager.GitRunStackedActionOptions;
});

/**
 * A failure (git's or a hook's stderr in it, at any depth) and a defect, masked for the asking
 * User; with every text field hidden when their values could not be read.
 */
const maskFailure = <A, E, R>(
  masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  if (Option.isNone(masker)) return effect;
  const masked = <X>(error: X) =>
    masker.value.forViewer.pipe(
      Effect.map((found) => found.maskError(error)),
      Effect.orElseSucceed(() => hideErrorText(error, HIDDEN_OUTPUT)),
    );
  return effect.pipe(
    Effect.catch((error: E) => Effect.flatMap(masked(error), Effect.fail)),
    Effect.catchDefect((defect) => Effect.flatMap(masked(defect), Effect.die)),
  );
};

/** A Git action whose failure is masked for the asking User ({@link maskFailure}). */
export const maskingGitErrors =
  <I, O, A, E, R>(
    masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
    run: (input: I, options: O) => Effect.Effect<A, E, R>,
  ) =>
  (input: I, options?: O): Effect.Effect<A, E, R> =>
    maskFailure(masker, run(input, options as O));

/** A service whose every method's failures are masked for the asking User (the Git workflow). */
export const maskingServiceFailures = <S extends object>(
  masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
  service: S,
): S => {
  if (Option.isNone(masker)) return service;
  const wrapped: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(service)) {
    wrapped[name] =
      typeof method !== "function"
        ? method
        : (...args: ReadonlyArray<unknown>) => {
            const answer = (method as (...args: ReadonlyArray<unknown>) => unknown)(...args);
            return Effect.isEffect(answer)
              ? // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- any method's own.
                maskFailure(masker, answer as Effect.Effect<unknown, unknown, unknown>)
              : answer;
          };
  }
  return wrapped as S;
};
