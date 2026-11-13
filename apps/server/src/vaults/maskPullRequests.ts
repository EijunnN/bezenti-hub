/**
 * Spec 5 ticket 05: what a method naming a change request answers (or fails with) is masked with
 * the asking User's own values. An edit carrying one of their `[NAME]`s was shown masked: refused,
 * or it would put `[NAME]` on the host in place of the value.
 */
import { PullRequestOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SecretMasker from "./SecretMasker.ts";

/** Methods that write text the User edited from what they were shown. */
const EDITS = new Set(["update", "updateComment"]);

const SHOWN_MASKED =
  "This text shows a secret as [NAME]; saving it would replace the secret. Edit it on the host.";

const namesAChangeRequest = (input: unknown) => {
  const ref = input as { readonly repository?: unknown; readonly number?: unknown } | null;
  return typeof ref?.repository === "string" && typeof ref.number === "number";
};

const placeholdersIn = (input: unknown, names: ReadonlySet<string>) => {
  const fields = input as { readonly title?: unknown; readonly body?: unknown };
  return [fields.title, fields.body].some(
    (text) =>
      typeof text === "string" &&
      [...text.matchAll(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g)].some((match) => names.has(match[1]!)),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `masked` with what was shown masked made read-only: a comment whose body changed can no longer
 * be edited (`canEdit`), nor a change request whose title or body did (`editChangeRequest`).
 */
const readOnlyWhereMasked = (original: unknown, masked: unknown): unknown => {
  if (original === masked) return masked;
  if (Array.isArray(original) && Array.isArray(masked)) {
    return masked.map((item, index) => readOnlyWhereMasked(original[index], item));
  }
  if (!isRecord(original) || !isRecord(masked)) return masked;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(masked)) {
    out[key] = readOnlyWhereMasked(original[key], value);
  }
  const textChanged = (key: string) =>
    typeof original[key] === "string" && original[key] !== masked[key];
  if (textChanged("body") && typeof out.canEdit === "boolean") out.canEdit = false;
  if ((textChanged("body") || textChanged("title")) && isRecord(out.viewerPermissions)) {
    out.viewerPermissions = { ...out.viewerPermissions, editChangeRequest: false };
  }
  return out;
};

/** The service, with every answer about a change request masked for the asking User. */
export const maskingPullRequestReads = <S extends object>(
  masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
  service: S,
): S => {
  if (Option.isNone(masker)) return service;
  const viewer = masker.value.forViewer;
  const wrapped: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(service)) {
    wrapped[name] =
      typeof method !== "function"
        ? method
        : (input: unknown, ...rest: ReadonlyArray<unknown>) => {
            const call = () =>
              (method as (...args: ReadonlyArray<unknown>) => unknown)(input, ...rest);
            if (!namesAChangeRequest(input)) return call();
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- any method's own answer.
            return Effect.gen(function* () {
              const found = yield* Effect.orDie(viewer);
              if (EDITS.has(name) && placeholdersIn(input, found.names)) {
                return yield* new PullRequestOperationError({
                  operation: name,
                  detail: SHOWN_MASKED,
                });
              }
              const answer = call();
              if (!Effect.isEffect(answer)) return answer;
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- any method's own answer.
              return yield* (answer as Effect.Effect<unknown, unknown, unknown>).pipe(
                Effect.map((value) => readOnlyWhereMasked(value, found.maskDeep(value))),
                // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- its own error.
                Effect.catch((error: unknown) => Effect.fail(found.maskError(error))),
              );
            });
          };
  }
  return wrapped as S;
};
