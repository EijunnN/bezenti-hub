/**
 * Spec 5 ticket 05: a checkout's file served by URL (large text, downloads, previews) goes to the
 * User who asks (the request's session; the URL's own User for sessionless embeds) masked with
 * their values when it is text that holds one. Media and binary files stream as they are.
 */
import type { UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerResponse } from "effect/http";
import * as Mime from "effect/http/Mime";
import * as Option from "effect/Option";

import * as SecretMasker from "./SecretMasker.ts";

/** The largest text file read whole to be masked. */
const MAX_MASKED_TEXT_BYTES = 16 * 1024 * 1024;
/** How much of a file is read to tell text from binary. */
const SNIFF_BYTES = 8192;
const NOT_STORED: Record<string, string> = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

/** Types served as they are: never text a process printed into. */
const isMedia = (contentType: string) =>
  /^(image|audio|video|font)\//.test(contentType) ||
  /^application\/(pdf|zip|gzip|x-tar|octet-stream|wasm)/.test(contentType);

/** Masked files, by file, revision and User: a range request reads them once. */
const maskedCache = new Map<string, Uint8Array>();
const MAX_CACHED = 32;

const rangeOf = (header: string | undefined, size: number) => {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return undefined;
  const start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = match[1] === "" || match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));
  return start > end || start >= size ? undefined : { start, end };
};

/**
 * The masked response, or undefined: serve the file as it is (media, binary, or nothing of the
 * User's in it). `user` is who asks; none (no session, a URL without a User) refuses text.
 */
export const maskedAssetText = Effect.fn("SecretMasker.maskedAssetText")(function* (
  filePath: string,
  user: Option.Option<UserId>,
  rangeHeader?: string,
  /** A download: served as an attachment under this name. */
  downloadName?: string,
) {
  const masker = yield* Effect.serviceOption(SecretMasker.SecretMasker);
  if (Option.isNone(masker)) return undefined;
  const contentType = Option.getOrElse(Mime.getType(filePath), () => "text/plain");
  if (isMedia(contentType)) return undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* Effect.option(fileSystem.stat(filePath));
  if (Option.isNone(info)) return undefined;
  // Binary (a NUL in its start): as it is, never read whole.
  const head = yield* Effect.option(
    Effect.scoped(
      Effect.flatMap(fileSystem.open(filePath), (file) => file.readAlloc(SNIFF_BYTES as never)),
    ),
  );
  if (Option.isSome(head) && Option.isSome(head.value) && head.value.value.includes(0)) {
    return undefined;
  }
  if (Option.isNone(user)) {
    return HttpServerResponse.text("Open this file from T3 Code.", {
      status: 403,
      headers: NOT_STORED,
    });
  }
  const found = yield* Effect.option(masker.value.forUser(user.value));
  if (Option.isNone(found)) {
    return HttpServerResponse.text("[content hidden: secrets could not be loaded]", {
      status: 503,
      headers: NOT_STORED,
    });
  }
  if (found.value.isEmpty) return undefined;
  if (info.value.size > BigInt(MAX_MASKED_TEXT_BYTES)) {
    return HttpServerResponse.text("This file is too large to check for secrets.", {
      status: 413,
      headers: NOT_STORED,
    });
  }
  const mtime = Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0;
  const key = `${filePath}\u0000${mtime}\u0000${info.value.size}\u0000${user.value}`;
  let body = maskedCache.get(key);
  if (body === undefined) {
    const bytes = yield* Effect.option(fileSystem.readFile(filePath));
    if (Option.isNone(bytes)) return undefined;
    const text = new TextDecoder().decode(bytes.value);
    const masked = found.value.mask(text);
    if (masked === text) return undefined;
    body = new TextEncoder().encode(masked);
    maskedCache.set(key, body);
    if (maskedCache.size > MAX_CACHED) {
      const oldest = maskedCache.keys().next().value;
      if (oldest !== undefined) maskedCache.delete(oldest);
    }
  }
  // The original type: a masked script or stylesheet still runs in a preview.
  const type = contentType.startsWith("text/") ? `${contentType}; charset=utf-8` : contentType;
  const headers = {
    ...NOT_STORED,
    "accept-ranges": "bytes",
    ...(downloadName === undefined
      ? {}
      : { "content-disposition": `attachment; filename="${encodeURIComponent(downloadName)}"` }),
  };
  const range = rangeOf(rangeHeader, body.byteLength);
  if (range !== undefined) {
    return HttpServerResponse.uint8Array(body.subarray(range.start, range.end + 1), {
      status: 206,
      contentType: type,
      headers: {
        ...headers,
        "content-range": `bytes ${range.start}-${range.end}/${body.byteLength}`,
      },
    });
  }
  return HttpServerResponse.uint8Array(body, {
    contentType: type,
    headers,
  });
});
