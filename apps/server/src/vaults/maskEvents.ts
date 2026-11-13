/**
 * Spec 5 ticket 05: what the event sink stores is masked first: every method whose input carries
 * `events`, `effects` (the outbox's payloads) or a Thread's `error` (a rejected command's receipt).
 * A method added later is wrapped too. A Thread whose set cannot be read stores nothing.
 */
import type { ProjectId, SpaceId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SecretMasker from "./SecretMasker.ts";

interface Masked {
  readonly events?: ReadonlyArray<unknown>;
  readonly effects?: ReadonlyArray<unknown>;
  readonly error?: string;
  readonly threadId?: string;
}

const threadOf = (item: unknown): string | undefined => {
  const threadId = (item as { readonly threadId?: unknown } | null)?.threadId;
  return typeof threadId === "string" ? threadId : undefined;
};

/** Where a Thread created in this write will be, and whose it is: from its `thread.created`. */
const hintFor = (
  events: ReadonlyArray<unknown>,
  threadId: string,
): SecretMasker.ThreadPlacementHint | undefined => {
  for (const event of events) {
    const created = event as {
      readonly type?: unknown;
      readonly threadId?: unknown;
      readonly payload?: {
        readonly ownerUserId?: UserId;
        readonly spaceId?: SpaceId;
        readonly projectId?: ProjectId | null;
      };
    };
    if (created.type === "thread.created" && created.threadId === threadId) {
      return {
        ownerUserId: created.payload?.ownerUserId,
        spaceId: created.payload?.spaceId,
        projectId: created.payload?.projectId ?? null,
      };
    }
  }
  return undefined;
};

const maskInput = Effect.fnUntraced(function* <I extends Masked>(
  masker: SecretMasker.SecretMasker["Service"],
  input: I,
) {
  const events = input.events ?? [];
  const maskers = new Map<string, SecretMasker.ThreadMasker>();
  const maskerFor = Effect.fnUntraced(function* (threadId: string | undefined) {
    if (threadId === undefined) return undefined;
    const known = maskers.get(threadId);
    if (known !== undefined) return known;
    const found = yield* masker.forThread(threadId, hintFor(events, threadId));
    maskers.set(threadId, found);
    return found;
  });
  const maskEach = Effect.fnUntraced(function* (items: ReadonlyArray<unknown> | undefined) {
    if (items === undefined) return undefined;
    const out: Array<unknown> = [];
    for (const item of items) {
      const found = yield* maskerFor(threadOf(item) ?? input.threadId);
      out.push(found === undefined ? item : found.maskDeep(item));
    }
    return out;
  });
  const maskedEvents = yield* maskEach(input.events);
  const maskedEffects = yield* maskEach(input.effects);
  const errorMasker =
    typeof input.error === "string" ? yield* maskerFor(input.threadId) : undefined;
  return {
    ...input,
    ...(maskedEvents === undefined ? {} : { events: maskedEvents }),
    ...(maskedEffects === undefined ? {} : { effects: maskedEffects }),
    ...(errorMasker === undefined || input.error === undefined
      ? {}
      : { error: errorMasker.mask(input.error) }),
  } as I;
});

const carriesText = (input: unknown): input is Masked =>
  typeof input === "object" &&
  input !== null &&
  (Array.isArray((input as Masked).events) ||
    Array.isArray((input as Masked).effects) ||
    typeof (input as Masked).error === "string");

/**
 * The sink, with every write masked first. A masking failure becomes `toError` (the sink's own
 * write error), so nothing is stored unmasked. Without a masker, the sink as is.
 */
export const maskingEventWrites = <S extends object>(
  masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
  sink: S,
  toError: (error: SecretMasker.SecretMaskingError, input: unknown) => unknown,
): S => {
  if (Option.isNone(masker)) return sink;
  const wrapped: Record<string, unknown> = {};
  for (const [key, method] of Object.entries(sink)) {
    wrapped[key] =
      typeof method !== "function"
        ? method
        : (input: unknown, ...rest: ReadonlyArray<unknown>) =>
            carriesText(input)
              ? // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- the sink's own error.
                maskInput(masker.value, input).pipe(
                  Effect.mapError((error) => toError(error, input)),
                  Effect.flatMap((masked) =>
                    (method as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(
                      masked,
                      ...rest,
                    ),
                  ),
                )
              : (method as (...args: ReadonlyArray<unknown>) => unknown)(input, ...rest);
  }
  return wrapped as S;
};
