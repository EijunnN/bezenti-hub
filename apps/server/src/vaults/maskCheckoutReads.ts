/**
 * Spec 5 ticket 05: a checkout's diffs and commits (the Changes panel) masked with the asking
 * User's own values (the request's principal; never another User's), answers and failures. A
 * masker that cannot be read fails the call.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { hideErrorText } from "@t3tools/shared/secretMasking";

import { HIDDEN_OUTPUT } from "./heldText.ts";
import { HIDDEN_CONTENT } from "./maskWorkspace.ts";

import type * as SecretMasker from "./SecretMasker.ts";

export const maskingCheckoutReads = <S extends object>(
  masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
  service: S,
): S => {
  if (Option.isNone(masker)) return service;
  // Values that cannot be read hide the text instead (never a defect, never unmasked).
  const viewer = Effect.map(Effect.option(masker.value.forViewer), (found) =>
    Option.isSome(found)
      ? { answer: found.value.maskDeep, failure: found.value.maskError }
      : {
          answer: <X>(value: X) => hideErrorText(value, HIDDEN_CONTENT),
          failure: <X>(error: X) => hideErrorText(error, HIDDEN_OUTPUT),
        },
  );
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
              Effect.flatMap((value) => Effect.map(viewer, (found) => found.answer(value))),
              Effect.catch((error: unknown) =>
                // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- its own error.
                Effect.flatMap(viewer, (found) => Effect.fail(found.failure(error))),
              ),
            );
          };
  }
  return wrapped as S;
};
