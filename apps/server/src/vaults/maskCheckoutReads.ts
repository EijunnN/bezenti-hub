/**
 * Spec 5 ticket 05: a checkout's diffs and commits (the Changes panel) name no Thread: each answer
 * of a method whose input names a `cwd` is masked with the values of the Threads that run in that
 * checkout on the Hub machine (the Owner's). A masker that cannot be read fails the call.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SecretMasker from "./SecretMasker.ts";

export const maskingCheckoutReads = <S extends object>(
  masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
  service: S,
): S => {
  if (Option.isNone(masker)) return service;
  const wrapped: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(service)) {
    wrapped[name] =
      typeof method !== "function"
        ? method
        : (input: unknown, ...rest: ReadonlyArray<unknown>) => {
            const answer = (method as (...args: ReadonlyArray<unknown>) => unknown)(input, ...rest);
            const cwd = (input as { readonly cwd?: unknown } | null)?.cwd;
            if (typeof cwd !== "string" || !Effect.isEffect(answer)) return answer;
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- any method's own answer.
            return Effect.flatMap(answer as Effect.Effect<unknown, unknown, unknown>, (value) =>
              Effect.map(Effect.orDie(masker.value.forCheckout(cwd)), (found) =>
                found.maskDeep(value),
              ),
            );
          };
  }
  return wrapped as S;
};
