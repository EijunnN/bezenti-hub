/**
 * Spec 5 ticket 05: what a method naming a change request answers (or fails with) is masked with
 * the asking User's own values. An edit carrying one of their `[NAME]`s was shown masked: refused,
 * or it would put `[NAME]` on the host in place of the value.
 */
import { PullRequestOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { hideErrorText } from "@t3tools/shared/secretMasking";

import { HIDDEN_OUTPUT } from "./heldText.ts";
import { HIDDEN_CONTENT, placeholderNames } from "./maskWorkspace.ts";

import type * as SecretMasker from "./SecretMasker.ts";

/** Methods that write text the User edited from what they were shown. */
const EDITS = new Set(["update", "updateComment"]);

const SHOWN_MASKED =
  "This text shows a secret as [NAME]; saving it would replace the secret. Edit it on the host.";

const namesAChangeRequest = (input: unknown) => {
  const ref = input as { readonly repository?: unknown; readonly number?: unknown } | null;
  return typeof ref?.repository === "string" && typeof ref.number === "number";
};

/** Whether an edit carries one of `names` as `[NAME]` (any `[NAME]` when they are unknown). */
const placeholdersIn = (input: unknown, names: ReadonlySet<string> | undefined) => {
  const fields = input as { readonly title?: unknown; readonly body?: unknown };
  return [fields.title, fields.body].some(
    (text) =>
      typeof text === "string" &&
      [...placeholderNames(text)].some((name) => names === undefined || names.has(name)),
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

/**
 * The service, with every Effect answer and failure masked for the asking User (lists too). When
 * their values cannot be read, its text is hidden (and read-only) instead.
 */
export const maskingPullRequestReads = <S extends object>(
  masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
  service: S,
): S => {
  if (Option.isNone(masker)) return service;
  const viewer = Effect.option(masker.value.forViewer);
  const wrapped: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(service)) {
    wrapped[name] =
      typeof method !== "function"
        ? method
        : (input: unknown, ...rest: ReadonlyArray<unknown>) => {
            const answer = (method as (...args: ReadonlyArray<unknown>) => unknown)(input, ...rest);
            if (!Effect.isEffect(answer)) return answer;
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- any method's own answer.
            return Effect.gen(function* () {
              const found = yield* viewer;
              const names = Option.isSome(found) ? found.value.names : undefined;
              if (EDITS.has(name) && namesAChangeRequest(input) && placeholdersIn(input, names)) {
                return yield* new PullRequestOperationError({
                  operation: name,
                  detail: SHOWN_MASKED,
                });
              }
              const hide = <X>(value: X): X =>
                Option.isSome(found)
                  ? found.value.maskDeep(value)
                  : hideErrorText(value, HIDDEN_CONTENT);
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- any method's own answer.
              return yield* (answer as Effect.Effect<unknown, unknown, unknown>).pipe(
                Effect.map((value) => readOnlyWhereMasked(value, hide(value))),
                Effect.catch((error: unknown) =>
                  // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- its own error.
                  Effect.fail(
                    Option.isSome(found)
                      ? found.value.maskError(error)
                      : hideErrorText(error, HIDDEN_OUTPUT),
                  ),
                ),
              );
            });
          };
  }
  return wrapped as S;
};
