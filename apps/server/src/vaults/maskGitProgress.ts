/**
 * Spec 5 ticket 05: what a client watches of a Git action (hook output, progress, errors) is
 * masked with the asking User's own values (never with a Thread the client names: a client cannot
 * pick whose values mask). When they cannot be read, hook output shows `HIDDEN_OUTPUT` and errors
 * are replaced by it.
 */
import type { GitActionProgressEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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

/** A Git action whose failure (git's or a hook's stderr in it) is masked for the asking User. */
export const maskingGitErrors =
  <I, O, A, E, R>(
    masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
    run: (input: I, options: O) => Effect.Effect<A, E, R>,
  ) =>
  (input: I, options: O): Effect.Effect<A, E, R> =>
    Option.isNone(masker)
      ? run(input, options)
      : run(input, options).pipe(
          Effect.catch((error: E) =>
            masker.value.forViewer.pipe(
              Effect.map((found) => found.maskError(error)),
              Effect.orElseSucceed(() => maskAll(error)),
              Effect.flatMap((masked) => Effect.fail(masked)),
            ),
          ),
        );

/** Every string of an error replaced: its values could not be read to hide them. */
const maskAll = <E>(error: E): E => {
  if (typeof error !== "object" || error === null) return error;
  const descriptors = Object.getOwnPropertyDescriptors(error);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key !== "_tag" && "value" in descriptor && typeof descriptor.value === "string") {
      descriptor.value = HIDDEN_OUTPUT;
    }
  }
  return Object.create(Object.getPrototypeOf(error), descriptors) as E;
};
