/**
 * Spec 5 ticket 05: a checkout's file served by URL (large text, downloads, previews) is served to
 * the User the URL was issued to masked with their own values, when it is text that holds one.
 * Binary files go as they are; a file too large to check, or values that cannot be read, refuse.
 */
import type { UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { HttpServerResponse } from "effect/http";

import * as SecretMasker from "./SecretMasker.ts";

/** The largest file read whole to be masked. */
const MAX_MASKED_ASSET_BYTES = 16 * 1024 * 1024;
const NOT_STORED = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

const TEXT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** The masked response, or undefined: serve the file as it is (nothing of the User's in it). */
export const maskedAssetText = Effect.fn("SecretMasker.maskedAssetText")(function* (
  filePath: string,
  viewer: UserId,
) {
  const masker = yield* Effect.serviceOption(SecretMasker.SecretMasker);
  if (Option.isNone(masker)) return undefined;
  const found = yield* Effect.option(masker.value.forUser(viewer));
  if (Option.isNone(found)) {
    return HttpServerResponse.text("This file could not be checked for secrets. Try again.", {
      status: 503,
      headers: NOT_STORED,
    });
  }
  if (found.value.isEmpty) return undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* Effect.option(fileSystem.stat(filePath));
  if (Option.isNone(info)) return undefined;
  if (info.value.size > BigInt(MAX_MASKED_ASSET_BYTES)) {
    return HttpServerResponse.text("This file is too large to check for secrets.", {
      status: 413,
      headers: NOT_STORED,
    });
  }
  const bytes = yield* Effect.option(fileSystem.readFile(filePath));
  if (Option.isNone(bytes)) return undefined;
  // Binary: as it is.
  if (bytes.value.subarray(0, 8192).includes(0)) return undefined;
  const text = new TextDecoder().decode(bytes.value);
  const masked = found.value.mask(text);
  if (masked === text) return undefined;
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return HttpServerResponse.text(masked, {
    contentType: TEXT_TYPES[extension] ?? "text/plain; charset=utf-8",
    headers: NOT_STORED,
  });
});
