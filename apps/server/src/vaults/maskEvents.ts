/**
 * Spec 5 ticket 05: domain events are masked before they are stored, projected or published.
 * `maskingEventWrites` wraps every method of the event sink whose input carries `events`, so a
 * write method added later is masked without anyone remembering to.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SecretMasker from "./SecretMasker.ts";

interface WithEvents {
  readonly events: ReadonlyArray<unknown>;
}

const hasEvents = (input: unknown): input is WithEvents =>
  typeof input === "object" &&
  input !== null &&
  Array.isArray((input as { readonly events?: unknown }).events);

const threadOf = (event: unknown): string | undefined => {
  const threadId = (event as { readonly threadId?: unknown } | null)?.threadId;
  return typeof threadId === "string" ? threadId : undefined;
};

/** Each event with every string masked by its own Thread's masker. */
const maskEvents: <E>(
  masker: SecretMasker.SecretMasker["Service"],
  events: ReadonlyArray<E>,
) => Effect.Effect<ReadonlyArray<E>> = Effect.fn("SecretMasker.maskEvents")(function* <E>(
  masker: SecretMasker.SecretMasker["Service"],
  events: ReadonlyArray<E>,
) {
  if (events.length === 0) return events;
  const byThread = new Map<string | undefined, SecretMasker.ThreadMasker>();
  for (const event of events) {
    const threadId = threadOf(event);
    if (!byThread.has(threadId)) byThread.set(threadId, yield* masker.forThread(threadId));
  }
  let changed = false;
  const masked = events.map((event) => {
    const next = byThread.get(threadOf(event))!.maskDeep(event);
    if (next !== event) changed = true;
    return next;
  });
  return changed ? masked : events;
});

/** The sink, with every write of `events` masked first. Without a masker, the sink as is. */
export const maskingEventWrites = <S extends object>(
  masker: Option.Option<SecretMasker.SecretMasker["Service"]>,
  sink: S,
): S => {
  if (Option.isNone(masker)) return sink;
  const wrapped: Record<string, unknown> = {};
  for (const [key, method] of Object.entries(sink)) {
    wrapped[key] =
      typeof method !== "function"
        ? method
        : (input: unknown, ...rest: ReadonlyArray<unknown>) =>
            hasEvents(input)
              ? Effect.flatMap(maskEvents(masker.value, input.events), (events) =>
                  (method as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(
                    { ...input, events },
                    ...rest,
                  ),
                )
              : (method as (...args: ReadonlyArray<unknown>) => unknown)(input, ...rest);
  }
  return wrapped as S;
};
