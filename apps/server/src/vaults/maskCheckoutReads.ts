/**
 * Spec 5 ticket 05: a checkout's diffs and commits (the Changes panel) masked with the asking
 * User's own values (the request's principal; never another User's), answers and failures. A
 * masker that cannot be read fails the call.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SecretMasker from "./SecretMasker.ts";

export const maskingCheckoutReads = <S extends object>(
  masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
  service: S,
): S => {
  if (Option.isNone(masker)) return service;
  const viewer = Effect.orDie(masker.value.forViewer);
  const wrapped: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(service)) {
    wrapped[name] =
      typeof method !== "function"
        ? method
        : (...args: ReadonlyArray<unknown>) => {
            const answer = (method as (...args: ReadonlyArray<unknown>) => unknown)(...args);
            if (!Effect.isEffect(answer)) return answer;
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- any method's own answer.
            return (answer as Effect.Effect<unknown, unknown, unknown>).pipe(
              Effect.flatMap((value) => Effect.map(viewer, (found) => found.maskDeep(value))),
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- any method's own error.
              Effect.catch((error: unknown) =>
                Effect.flatMap(viewer, (found) => Effect.fail(found.maskError(error))),
              ),
            );
          };
  }
  return wrapped as S;
};
