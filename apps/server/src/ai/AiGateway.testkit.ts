// @effect-diagnostics nodeBuiltinImport:off -- builds fake CLIProxyAPI release archives on disk for the gateway's tests.
/**
 * A stand-in CLIProxyAPI for tests: a release archive whose `cli-proxy-api` is a shell script
 * running a small Node server that answers the management API and `/v1/models` like the real one.
 * Nothing is downloaded: tests hand the archives to the Hub through a fake `CliproxyReleases`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AiGatewayError } from "@t3tools/contracts";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { type CliproxyPlatform, cliproxyAssetName } from "./cliproxyRelease.ts";
import { CliproxyReleases } from "./CliproxyReleases.ts";

/** What the fake server does: serve, or exit at once (a release that never starts). */
export type FakeCliproxyMode = "serve" | "exit";

const FAKE_SERVER = String.raw`
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
const configPath = process.argv[process.argv.indexOf("-config") + 1];
const text = fs.readFileSync(configPath, "utf8");
const port = Number(/^\s+port:\s*(\d+)/mu.exec(text)[1]);
const host = /^\s+host:\s*"?([^"\n]+)"?/mu.exec(text)[1];
const secret = /secret-key:\s*"?([^"\n]+)"?/u.exec(text)[1].trim();
const clientKey = /api-keys:\s*\n\s*-\s*"?([^"\n]+)"?/u.exec(text)[1].trim();
const version = process.env.FAKE_CLIPROXY_VERSION;
fs.writeFileSync(path.join(path.dirname(configPath), "fake-" + process.pid + ".json"), JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env), version }));
// Like a careless release: its own keys in its output, which the Hub must filter.
console.log("CLIProxyAPI Version: " + version + ", management key " + secret + ", client key " + clientKey);
if (process.env.FAKE_CLIPROXY_MODE === "exit") process.exit(3);
http.createServer((request, response) => {
  const auth = request.headers.authorization ?? "";
  response.setHeader("X-CPA-VERSION", version);
  if (request.url === "/v8/management/config") {
    response.statusCode = auth === "Bearer " + secret ? 200 : 401;
    response.end(JSON.stringify(response.statusCode === 200 ? { "config-version": 8 } : { error: "missing management key" }));
    return;
  }
  if (request.url === "/v1/models") {
    response.statusCode = auth === "Bearer " + clientKey ? 200 : 401;
    response.end(JSON.stringify({ data: [] }));
    return;
  }
  response.statusCode = 404;
  response.end();
}).listen(port, host);
`;

const tarHeader = (name: string, size: number, mode: number) => {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write(
    `${Math.floor(Date.UTC(2026, 0, 1) / 1000)
      .toString(8)
      .padStart(11, "0")}\0`,
    136,
    12,
    "ascii",
  );
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\u000000", 257, 8, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
};

const tarOf = (files: ReadonlyArray<{ name: string; content: Buffer; mode: number }>) =>
  Buffer.concat([
    ...files.flatMap(({ name, content, mode }) => [
      tarHeader(name, content.length, mode),
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
    ]),
    Buffer.alloc(1024),
  ]);

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export interface FakeRelease {
  readonly version: string;
  readonly archive: Uint8Array;
  readonly sha256: string;
}

/**
 * A release archive whose `cli-proxy-api` runs the fake server with this test's Node. The server
 * itself is written once into `dir`.
 */
export const fakeCliproxyRelease = (
  dir: string,
  version: string,
  mode: FakeCliproxyMode = "serve",
): FakeRelease => {
  const server = NodePath.join(dir, "fake-cliproxy.mjs");
  if (!NodeFS.existsSync(server)) NodeFS.writeFileSync(server, FAKE_SERVER);
  const script = Buffer.from(
    `#!/bin/sh\nFAKE_CLIPROXY_VERSION=${version} FAKE_CLIPROXY_MODE=${mode} exec "${process.execPath}" "${server}" "$@"\n`,
  );
  const archive = NodeZlib.gzipSync(
    tarOf([
      { name: "LICENSE", content: Buffer.from("MIT\n"), mode: 0o644 },
      { name: "cli-proxy-api", content: script, mode: 0o755 },
    ]),
  );
  return { version, archive, sha256: sha256(archive) };
};

/** GitHub as the tests see it: these releases, their checksums, and a count of each download. */
export const fakeReleases = (input: {
  readonly platform: CliproxyPlatform;
  readonly releases: ReadonlyArray<FakeRelease>;
  readonly latest: string;
  /** Per version: what the release's `checksums.txt` says instead of the archive's real hash. */
  readonly listed?: Readonly<Record<string, string | null>>;
}) => {
  const downloads: Array<string> = [];
  const find = (version: string) => input.releases.find((release) => release.version === version);
  const missing = (version: string) =>
    new AiGatewayError({ message: `Could not download CLIProxyAPI ${version} from GitHub.` });
  const service = CliproxyReleases.of({
    latestVersion: Effect.succeed(input.latest),
    checksums: (version) => {
      const release = find(version);
      if (release === undefined) return Effect.fail(missing(version));
      const listed = input.listed?.[version];
      const hash = listed === undefined ? release.sha256 : listed;
      return Effect.succeed(
        `${"0".repeat(64)}  CLIProxyAPI_${version}_windows_amd64.zip\n` +
          (hash === null ? "" : `${hash}  ${cliproxyAssetName(version, input.platform)}\n`),
      );
    },
    archive: (version) =>
      Effect.suspend(() => {
        const release = find(version);
        if (release === undefined) return Effect.fail(missing(version));
        downloads.push(version);
        return Effect.succeed(release.archive);
      }),
  });
  return { service, downloads };
};

/** The encrypted store, in memory. */
export const memorySecretStore = () => {
  const entries = new Map<string, Uint8Array>();
  return {
    entries,
    service: ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(entries.get(name))),
      set: (name, value) => Effect.sync(() => void entries.set(name, value)),
      create: (name, value) => Effect.sync(() => void entries.set(name, value)),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => {
          const existing = entries.get(name);
          if (existing !== undefined) return existing;
          const created = new Uint8Array(NodeCrypto.randomBytes(bytes));
          entries.set(name, created);
          return created;
        }),
      remove: (name) => Effect.sync(() => void entries.delete(name)),
    }),
  };
};
