import * as Effect from "effect/Effect";
import type * as Socket from "effect/socket/Socket";

const textDecoder = new TextDecoder();

/** Reads one text frame at a time from a socket that may deliver several per pull. */
export const makeFrameReader = (
  reader: Socket.Reader,
): Effect.Effect<string, Socket.SocketError> => {
  const pending: Array<string> = [];
  return Effect.suspend(function next(): Effect.Effect<string, Socket.SocketError> {
    const frame = pending.shift();
    if (frame !== undefined) return Effect.succeed(frame);
    return reader.pull.pipe(
      Effect.flatMap((chunks) => {
        for (const chunk of chunks) {
          pending.push(typeof chunk === "string" ? chunk : textDecoder.decode(chunk));
        }
        return next();
      }),
    );
  });
};
