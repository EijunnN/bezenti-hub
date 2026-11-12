/**
 * Where CLIProxyAPI releases come from: GitHub, at the fixed addresses of cliproxyRelease.ts and
 * nowhere else. Asked only when the Hub installs a release or the Owner checks for updates (ADR
 * 0007: no upstream service by default). Tests give their own files.
 */
import { AiGatewayError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  CLIPROXY_LATEST_RELEASE_URL,
  type CliproxyPlatform,
  cliproxyAssetUrl,
  cliproxyChecksumsUrl,
  versionOfTag,
} from "./cliproxyRelease.ts";

/** Larger than any release archive so far (about 25 MB), so a runaway answer is cut short. */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

export class CliproxyReleases extends Context.Service<
  CliproxyReleases,
  {
    /** The newest release's version. */
    readonly latestVersion: Effect.Effect<string, AiGatewayError>;
    /** That release's `checksums.txt`. */
    readonly checksums: (version: string) => Effect.Effect<string, AiGatewayError>;
    /** That release's archive for this platform, not yet verified. */
    readonly archive: (
      version: string,
      platform: CliproxyPlatform,
    ) => Effect.Effect<Uint8Array, AiGatewayError>;
  }
>()("t3/ai/CliproxyReleases") {}

const LatestRelease = Schema.Struct({ tag_name: Schema.String });

const unreachable = (what: string) => () =>
  new AiGatewayError({ message: `Could not download ${what} from GitHub.` });

const make = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeader("User-Agent", "t3code-hub")),
  );
  const get = (url: string, timeout: "30 seconds" | "5 minutes") =>
    client
      .get(url)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.timeout(timeout));

  return CliproxyReleases.of({
    latestVersion: get(CLIPROXY_LATEST_RELEASE_URL, "30 seconds").pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(LatestRelease)),
      Effect.mapError(unreachable("the latest CLIProxyAPI release")),
      Effect.flatMap(({ tag_name }) => {
        const version = versionOfTag(tag_name);
        return version === undefined
          ? Effect.fail(
              new AiGatewayError({ message: "GitHub named a release that is not a version." }),
            )
          : Effect.succeed(version);
      }),
      Effect.withSpan("CliproxyReleases.latestVersion"),
    ),
    checksums: Effect.fn("CliproxyReleases.checksums")(function* (version: string) {
      return yield* get(cliproxyChecksumsUrl(version), "30 seconds").pipe(
        Effect.flatMap((response) => response.text),
        Effect.mapError(unreachable(`the checksums of CLIProxyAPI ${version}`)),
      );
    }),
    archive: Effect.fn("CliproxyReleases.archive")(function* (
      version: string,
      platform: CliproxyPlatform,
    ) {
      const tooLarge = new AiGatewayError({ message: `CLIProxyAPI ${version} is too large.` });
      const response = yield* get(cliproxyAssetUrl(version, platform), "5 minutes").pipe(
        Effect.mapError(unreachable(`CLIProxyAPI ${version}`)),
      );
      if (Number(response.headers["content-length"] ?? "0") > MAX_ARCHIVE_BYTES) {
        return yield* tooLarge;
      }
      const buffer = yield* response.arrayBuffer.pipe(
        Effect.timeout("5 minutes"),
        Effect.mapError(unreachable(`CLIProxyAPI ${version}`)),
      );
      if (buffer.byteLength > MAX_ARCHIVE_BYTES) return yield* tooLarge;
      return new Uint8Array(buffer);
    }),
  });
});

export const layer = Layer.effect(CliproxyReleases, make);
