/**
 * Spec 5 ticket 05: a change request shows what the agents of the Threads linked to it pushed.
 * Every answer of a service method that names a change request (`repository` and `number`) is
 * masked with those Threads' values, and so is a review guide before it is stored. A masker that
 * cannot be read fails the call.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SecretMasker from "./SecretMasker.ts";

const keyOf = (input: unknown) => {
  const ref = input as { readonly repository?: unknown; readonly number?: unknown } | null;
  return typeof ref?.repository === "string" && typeof ref.number === "number"
    ? { repository: ref.repository, number: ref.number }
    : undefined;
};

/** The service, with every Effect answer about a change request masked. */
export const maskingPullRequestReads = <S extends object>(
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
            const key = keyOf(input);
            if (key === undefined || !Effect.isEffect(answer)) return answer;
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- any method's own answer.
            return Effect.flatMap(answer as Effect.Effect<unknown, unknown, unknown>, (value) =>
              Effect.map(Effect.orDie(masker.value.forPullRequest(key)), (found) =>
                found.maskDeep(value),
              ),
            );
          };
  }
  return wrapped as S;
};
