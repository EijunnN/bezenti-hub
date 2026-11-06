/**
 * Request/response and events over one Hub ↔ Environment socket, the same on both ends. Payloads
 * are already in their JSON codecs (`RemoteExecutorWire.ts`); the channel only matches responses to
 * requests and hands events and incoming requests to the owner.
 */
import {
  EnvironmentEventFrame,
  EnvironmentRequestFrame,
  EnvironmentResponseFrame,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/** The socket closed, or was never open, before the other side answered. */
export class ExecutorChannelClosedError extends Schema.TaggedError<ExecutorChannelClosedError>()(
  "ExecutorChannelClosedError",
  { method: Schema.String },
) {
  override get message(): string {
    return `The Environment connection closed before '${this.method}' was answered.`;
  }
}

export type ExecutorCallResult =
  | { readonly _tag: "success"; readonly value: unknown }
  | { readonly _tag: "failure"; readonly error: unknown };

const ChannelFrame = Schema.Union([
  EnvironmentRequestFrame,
  EnvironmentResponseFrame,
  EnvironmentEventFrame,
]);
const decodeChannelFrame = Schema.decodeUnknownOption(ChannelFrame);

export interface ExecutorChannel {
  readonly request: (input: {
    readonly method: string;
    readonly payload: unknown;
    readonly idempotencyKey?: string;
  }) => Effect.Effect<ExecutorCallResult, ExecutorChannelClosedError>;
  readonly event: (method: string, payload: unknown) => Effect.Effect<void>;
  /**
   * Handles a decoded `request`, `response` or `event` frame. Answers false for anything else, so
   * the owner can read hello, heartbeat and welcome frames itself.
   */
  readonly receive: (frame: unknown) => Effect.Effect<boolean>;
  /** Fails every pending request; later requests fail at once. */
  readonly close: Effect.Effect<void>;
}

export const makeExecutorChannel = Effect.fn("ExecutorChannel.make")(function* (options: {
  readonly environmentId: EnvironmentId;
  /** Writes one frame; a failed write surfaces as the socket closing. */
  readonly write: (text: string) => Effect.Effect<void>;
  readonly onRequest: (request: {
    readonly method: string;
    readonly payload: unknown;
    readonly idempotencyKey: string | undefined;
  }) => Effect.Effect<ExecutorCallResult>;
  readonly onEvent: (method: string, payload: unknown) => Effect.Effect<void>;
}) {
  const pending = new Map<
    string,
    { method: string; answer: Deferred.Deferred<ExecutorCallResult, ExecutorChannelClosedError> }
  >();
  let closed = false;
  let nextId = 0;
  // Frames from concurrent fibers must not interleave inside one socket write.
  const writeLock = yield* Semaphore.make(1);
  const send = (frame: unknown) => writeLock.withPermits(1)(options.write(JSON.stringify(frame)));

  const request: ExecutorChannel["request"] = (input) =>
    Effect.suspend(() => {
      if (closed) return Effect.fail(new ExecutorChannelClosedError({ method: input.method }));
      nextId += 1;
      const requestId = `${options.environmentId}:${nextId}`;
      const answer = Deferred.makeUnsafe<ExecutorCallResult, ExecutorChannelClosedError>();
      pending.set(requestId, { method: input.method, answer });
      return send({
        type: "request",
        requestId,
        method: input.method,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        payload: input.payload,
      }).pipe(
        Effect.andThen(Deferred.await(answer)),
        Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
      );
    });

  const receive: ExecutorChannel["receive"] = (raw) =>
    Effect.suspend(() => {
      const decoded = decodeChannelFrame(raw);
      if (Option.isNone(decoded)) return Effect.succeed(false);
      const frame = decoded.value;
      switch (frame.type) {
        case "response": {
          const entry = pending.get(frame.requestId);
          if (entry === undefined) return Effect.succeed(true);
          const result: ExecutorCallResult =
            frame.result._tag === "success"
              ? { _tag: "success", value: frame.result.value }
              : { _tag: "failure", error: frame.result.error };
          return Deferred.succeed(entry.answer, result).pipe(Effect.as(true));
        }
        case "event":
          return options.onEvent(frame.method, frame.payload).pipe(Effect.as(true));
        case "request":
          // Answered on its own fiber: a slow call must not hold the reader.
          return options
            .onRequest({
              method: frame.method,
              payload: frame.payload,
              idempotencyKey: frame.idempotencyKey,
            })
            .pipe(
              Effect.flatMap((result) =>
                send({
                  type: "response",
                  requestId: frame.requestId,
                  result:
                    result._tag === "success"
                      ? { _tag: "success", value: result.value ?? null }
                      : { _tag: "failure", error: result.error ?? null },
                }),
              ),
              Effect.forkDetach,
              Effect.as(true),
            );
      }
    });

  return {
    request,
    event: (method, payload) => (closed ? Effect.void : send({ type: "event", method, payload })),
    receive,
    close: Effect.suspend(() => {
      closed = true;
      const entries = [...pending.values()];
      pending.clear();
      return Effect.forEach(
        entries,
        (entry) =>
          Deferred.fail(entry.answer, new ExecutorChannelClosedError({ method: entry.method })),
        { discard: true },
      );
    }),
  } satisfies ExecutorChannel;
});
