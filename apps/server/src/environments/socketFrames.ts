import * as Effect from "effect/Effect";
import type * as Socket from "effect/socket/Socket";

const textDecoder = new TextDecoder();

/** The next text frame; `buffered` counts frames already pulled but not read yet. */
export type FrameReader = Effect.Effect<string, Socket.SocketError> & {
  readonly buffered: () => number;
};

/** Reads one text frame at a time from a socket that may deliver several per pull. */
export const makeFrameReader = (reader: Socket.Reader): FrameReader => {
  const pending: Array<string> = [];
  const next: Effect.Effect<string, Socket.SocketError> = Effect.suspend(() => {
    const frame = pending.shift();
    if (frame !== undefined) return Effect.succeed(frame);
    return reader.pull.pipe(
      Effect.flatMap((chunks) => {
        for (const chunk of chunks) {
          pending.push(typeof chunk === "string" ? chunk : textDecoder.decode(chunk));
        }
        return next;
      }),
    );
  });
  return Object.assign(next, { buffered: () => pending.length });
};
