// @effect-diagnostics nodeBuiltinImport:off -- hashes the download as it arrives.
/**
 * Where pinned CLIProxyAPI releases come from: GitHub, at the address cliproxyRelease.ts builds
 * from a pinned version and nowhere else, read as a stream with a hard size limit and hashed as it
 * arrives. Asked only to install a release. Tests give their own archives.
 */
import * as NodeCrypto from "node:crypto";

import { AiGatewayError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  type CliproxyPlatform,
  cliproxyAssetUrl,
  type PinnedCliproxyRelease,
} from "./cliproxyRelease.ts";

const isAiGatewayError = Schema.is(AiGatewayError);

/** Larger than any release archive so far (about 25 MB), so a runaway answer is cut short. */
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

/** A downloaded archive, not yet checked, and the SHA-256 of what arrived. */
export interface DownloadedArchive {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export class CliproxyReleases extends Context.Service<
  CliproxyReleases,
  {
    readonly archive: (
      release: PinnedCliproxyRelease,
      platform: CliproxyPlatform,
    ) => Effect.Effect<DownloadedArchive, AiGatewayError>;
  }
>()("t3/ai/CliproxyReleases") {}

/**
 * Chunks collected only up to `limit` bytes, whatever the answer announced (or did not), and
 * hashed on the way.
 */
export const collectLimited = Effect.fn("CliproxyReleases.collectLimited")(function* <E>(
  chunks: Stream.Stream<Uint8Array, E>,
  limit: number,
  tooLarge: () => AiGatewayError,
) {
  const hash = NodeCrypto.createHash("sha256");
  const parts: Array<Uint8Array> = [];
  let total = 0;
  yield* chunks.pipe(
    Stream.runForEach((chunk) => {
      total += chunk.byteLength;
      if (total > limit) return Effect.fail(tooLarge());
      hash.update(chunk);
      parts.push(chunk);
      return Effect.void;
    }),
  );
  return {
    bytes: new Uint8Array(Buffer.concat(parts)),
    sha256: hash.digest("hex"),
  } satisfies DownloadedArchive;
});

const make = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeader("User-Agent", "t3code-hub")),
  );
  return CliproxyReleases.of({
    archive: Effect.fn("CliproxyReleases.archive")(function* (
      release: PinnedCliproxyRelease,
      platform: CliproxyPlatform,
    ) {
      const unreachable = () =>
        new AiGatewayError({ message: `Could not download CLIProxyAPI ${release.version}.` });
      const tooLarge = () =>
        new AiGatewayError({
          message: `The download of CLIProxyAPI ${release.version} is too large.`,
        });
      const response = yield* client
        .get(cliproxyAssetUrl(release, platform))
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.timeout("30 seconds"),
          Effect.mapError(unreachable),
        );
      if (Number(response.headers["content-length"] ?? "0") > MAX_ARCHIVE_BYTES) {
        return yield* tooLarge();
      }
      return yield* collectLimited(
        response.stream.pipe(Stream.mapError(unreachable)),
        MAX_ARCHIVE_BYTES,
        tooLarge,
      ).pipe(
        Effect.timeout("5 minutes"),
        Effect.mapError((error) => (isAiGatewayError(error) ? error : unreachable())),
      );
    }),
  });
});

export const layer = Layer.effect(CliproxyReleases, make);
