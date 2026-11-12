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

import { AiGatewayError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import * as AuditLog from "../audit/AuditLog.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as AiGateway from "./AiGateway.ts";
import type { CliproxyPlatform, PinnedCliproxyRelease } from "./cliproxyRelease.ts";
import { CliproxyReleases } from "./CliproxyReleases.ts";

/**
 * What the fake does: `serve`; `exit` at once (a release that never starts); `wide`, listening on
 * every address; `refuse`, serving but refusing every config change; `decoy`, leaving the port to another process that records what it is sent (as a
 * local process that took the port first would).
 */
export type FakeCliproxyMode = "serve" | "exit" | "wide" | "decoy" | "refuse";

/** A line a careless release might print: credentials by name and by shape. */
export const LEAKY_LINE =
  'token refresh {"refresh_token":"1//0gLeakyRefreshToken_abc-123","access_token":"ya29.a0Leaky_Access-Token123"} ' +
  "url=https://x.test/v1?key=AIzaSyLeaky_Google-Key1234567890&api_key=sk-ant-leaky_key_1234567890 " +
  "client_secret=GOCSPX-leaky_secret_123 github ghp_Leaky_Github_Token_1234567890";

const FAKE_SERVER =
  String.raw`
import * as childProcess from "node:child_process";
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
const mode = process.env.FAKE_CLIPROXY_MODE;
const dir = path.dirname(configPath);
fs.writeFileSync(path.join(dir, "fake-" + process.pid + ".json"), JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env), version }));
// Like a careless release: its own keys and tokens in its output, which the Hub must filter.
console.log("CLIProxyAPI Version: " + version + ", management key " + secret + ", client key " + clientKey);
console.log(${JSON.stringify(LEAKY_LINE)});
if (mode === "exit") process.exit(3);
if (mode === "decoy") {
  const decoy = childProcess.spawn(process.execPath, ["-e", ` +
  "`" +
  String.raw`
    const fs = require("node:fs");
    const seen = process.argv[2];
    require("node:http").createServer((request, response) => {
      fs.appendFileSync(seen, JSON.stringify({ url: request.url, authorization: request.headers.authorization ?? null }) + "\n");
      response.statusCode = 200;
      response.end("{}");
    }).listen(Number(process.argv[1]), "127.0.0.1");
  ` +
  "`" +
  String.raw`, String(port), path.join(dir, "decoy-seen.jsonl")], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "decoy-pid"), String(decoy.pid));
  process.on("SIGTERM", () => { decoy.kill("SIGKILL"); process.exit(0); });
  setInterval(() => {}, 1000);
} else {
  // The AI accounts' API keys, as the management API sets them (PATCH of the whole section),
  // and the models each prefix serves: an openai-compatibility entry's own, else a small catalog.
  let apiKeys = {};
  const CATALOG = { claude: ["claude-sonnet-5-5"], codex: ["gpt-5.5"], gemini: ["gemini-3-pro"], vertex: ["gemini-3-pro"], xai: ["grok-5"], meta: ["muse-spark-1.3"] };
  const modelIds = () => Object.entries(apiKeys).flatMap(([block, entries]) =>
    (Array.isArray(entries) ? entries : []).flatMap((entry) =>
      (block === "openai-compatibility" ? (entry.models ?? []).map((model) => model.alias ?? model.name) : CATALOG[block] ?? [])
        .map((model) => entry.prefix + "/" + model)));
  const invalid = (patch) => {
    for (const [block, entries] of Object.entries(patch["api-keys"] ?? {})) {
      if (!Array.isArray(entries)) return "api-keys." + block + " must be a list";
      for (const [index, entry] of entries.entries()) {
        if (!Array.isArray(entry.keys)) return "api-keys." + block + "[" + index + "].keys must be a list";
        if (entry.keys.some((key) => typeof key["api-key"] !== "string")) return "api-keys." + block + "[" + index + "] key";
        // Like a provider CLIProxyAPI cannot use, quoting what it was sent.
        if (String(entry["base-url"] ?? "").includes("refuse.invalid")) return "api-keys." + block + "[" + index + "] cannot use base-url with key ` +
  "`" +
  String.raw`" + entry.keys[0]["api-key"] + "` +
  "`" +
  String.raw`";
      }
    }
    return undefined;
  };
  http.createServer((request, response) => {
    const auth = request.headers.authorization ?? "";
    response.setHeader("X-CPA-VERSION", version);
    if (request.url === "/v8/management/config") {
      if (auth !== "Bearer " + secret) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "missing management key" }));
        return;
      }
      if (request.method === "PATCH") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const patch = JSON.parse(body);
          fs.appendFileSync(path.join(dir, "fake-patches.log"), "patch" + String.fromCharCode(10));
          const problem = invalid(patch);
          // A file fake-refuse-all beside the config: refuses every change from now on, like a broken release.
          if (problem !== undefined || mode === "refuse" || fs.existsSync(path.join(dir, "fake-refuse-all"))) {
            response.statusCode = 422;
            response.end(JSON.stringify({ error: "invalid_config", message: problem ?? "refused" }));
            return;
          }
          apiKeys = { ...apiKeys, ...(patch["api-keys"] ?? {}) };
          fs.writeFileSync(path.join(dir, "fake-api-keys-" + process.pid + ".json"), JSON.stringify(apiKeys));
          response.statusCode = 200;
          response.end(JSON.stringify({ "config-version": 8, status: "ok" }));
        });
        return;
      }
      response.statusCode = 200;
      response.end(JSON.stringify({ "config-version": 8, "api-keys": apiKeys }));
      return;
    }
    if (request.url === "/v1/models") {
      response.statusCode = fs.existsSync(path.join(dir, "fake-models-down")) ? 503 : auth === "Bearer " + clientKey ? 200 : 401;
      response.end(JSON.stringify({ data: response.statusCode === 200 ? modelIds().map((id) => ({ id, object: "model" })) : [] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  }).listen(port, mode === "wide" ? "0.0.0.0" : host);
}
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

/** The Hub's pins for these fake releases, the same hash on every platform. */
export const pinsOf = (releases: ReadonlyArray<FakeRelease>): Array<PinnedCliproxyRelease> =>
  releases.map((release) => ({
    version: release.version,
    sha256: {
      "linux-amd64": release.sha256,
      "linux-arm64": release.sha256,
      "darwin-amd64": release.sha256,
      "darwin-arm64": release.sha256,
    },
  }));

/**
 * GitHub as the tests see it: these archives (or, per version, other bytes in their place), and
 * a list of each download.
 */
export const fakeReleases = (input: {
  readonly releases: ReadonlyArray<FakeRelease>;
  readonly served?: Readonly<Record<string, Uint8Array>>;
}) => {
  const downloads: Array<string> = [];
  const service = CliproxyReleases.of({
    archive: (release: PinnedCliproxyRelease, _platform: CliproxyPlatform) =>
      Effect.suspend(() => {
        const found = input.releases.find((candidate) => candidate.version === release.version);
        if (found === undefined) {
          return Effect.fail(
            new AiGatewayError({ message: `Could not download CLIProxyAPI ${release.version}.` }),
          );
        }
        downloads.push(release.version);
        const bytes = input.served?.[release.version] ?? found.archive;
        return Effect.succeed({ bytes, sha256: sha256(bytes) });
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

/**
 * A gateway as a Hub runs it, over a fake release, in the caller's scope: for tests of what else
 * can reach it. Resolves with its loopback port once it answers.
 */
export const startFakeGateway = Effect.fn("AiGateway.testkit.startFakeGateway")(function* (input: {
  readonly dir: string;
  readonly os: NodeJS.Platform;
  readonly platform: CliproxyPlatform;
}) {
  const release = fakeCliproxyRelease(input.dir, "1.0.0");
  const stateDir = NodePath.join(input.dir, "state");
  NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const gateway = yield* AiGateway.make({
    placement: { _tag: "forced", enabled: true },
    os: input.os,
    stateDir,
    platform: input.platform,
    pinned: pinsOf([release]),
    runtimeFolder: { directory: NodePath.join(input.dir, "memory"), inMemory: true },
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ServerSecretStore, memorySecretStore().service),
        Layer.succeed(CliproxyReleases, fakeReleases({ releases: [release] }).service),
        Layer.succeed(
          AuditLog.AuditLog,
          AuditLog.AuditLog.of({ record: () => Effect.void, list: () => Effect.die("not used") }),
        ),
        FetchHttpClient.layer,
      ),
    ),
  );
  const running = yield* gateway.changes.pipe(
    Stream.filter((status) => status.state === "running" || status.state === "failed"),
    Stream.runHead,
  );
  const endpoint = yield* gateway.endpoint;
  if (Option.isNone(running) || Option.isNone(endpoint)) {
    return yield* Effect.die(new Error("The fake AI gateway did not start."));
  }
  return Number(new URL(endpoint.value.baseUrl).port);
});
