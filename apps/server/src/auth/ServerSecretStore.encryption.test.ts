/**
 * The Hub's secret store encrypts every entry at rest with its master key (spec 5 «Vaults», ticket
 * 01). Real files in a real state directory: what a copy of the disk shows, what a missing or wrong
 * key does at startup, the one-time encryption of plaintext stores, rotation and import.
 */
// @effect-diagnostics nodeBuiltinImport:off - the tests read the store's files as a copy would.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const newBaseDir = () =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-secret-enc-")));
const stateDirOf = (baseDir: string) => NodePath.join(baseDir, "userdata");
const secretsDirOf = (baseDir: string) => NodePath.join(stateDirOf(baseDir), "secrets");
const keyFileOf = (baseDir: string) => NodePath.join(stateDirOf(baseDir), "master.key");

const configAt = (baseDir: string) => ServerConfig.layerTest(process.cwd(), baseDir);

/** The store as the Hub builds it over `baseDir`, on the real file system unless one is given. */
const storeAt = (baseDir: string, fileSystem?: Layer.Layer<FileSystem.FileSystem>) =>
  ServerSecretStore.layer.pipe(
    Layer.provideMerge(configAt(baseDir)),
    Layer.provideMerge(fileSystem ?? Layer.empty),
  );

const withStore = <A, E>(
  baseDir: string,
  body: (store: ServerSecretStore.ServerSecretStore["Service"]) => Effect.Effect<A, E>,
  fileSystem?: Layer.Layer<FileSystem.FileSystem>,
) =>
  Effect.flatMap(ServerSecretStore.ServerSecretStore, body).pipe(
    Effect.provide(storeAt(baseDir, fileSystem)),
  );

/** Every file under `dir`, recursively, with its bytes. */
const filesUnder = (dir: string): Array<{ readonly path: string; readonly bytes: Buffer }> =>
  NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [{ path, bytes: NodeFS.readFileSync(path) }];
  });

const seedPlaintext = (baseDir: string, entries: Record<string, string>) => {
  NodeFS.mkdirSync(secretsDirOf(baseDir), { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(entries)) {
    NodeFS.writeFileSync(NodePath.join(secretsDirOf(baseDir), `${name}.bin`), value, {
      mode: 0o600,
    });
  }
};

const readAll = (baseDir: string, names: ReadonlyArray<string>) =>
  withStore(baseDir, (store) =>
    Effect.forEach(names, (name) =>
      store.get(name).pipe(Effect.map(Option.map((bytes) => decoder.decode(bytes)))),
    ),
  );

/** A file system whose `rename` fails from its `failFrom`-th call on, as a crash would stop it. */
const layerRenameFailsFrom = (failFrom: number) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let calls = 0;
      return {
        ...fileSystem,
        rename: (from, to) => {
          calls += 1;
          return calls >= failFrom
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: `${from} -> ${to}`,
                  description: "The process stopped here.",
                }),
              )
            : fileSystem.rename(from, to);
        },
      } satisfies FileSystem.FileSystem;
    }),
  ).pipe(Layer.provide(platform));

const SECRET = "sk-live-PLAINTEXT-must-never-show-4471";

it.layer(platform)("ServerSecretStore encryption", (it) => {
  describe("at rest", () => {
    it.effect("no file of the store holds a value it wrote", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) =>
          Effect.gen(function* () {
            yield* store.set("provider-token", encoder.encode(SECRET));
            yield* store.create("created-token", encoder.encode(`${SECRET}-created`));
            const random = yield* store.getOrCreateRandom("signing-key", 32);
            const back = yield* store.get("provider-token");
            assert.equal(decoder.decode(Option.getOrThrow(back)), SECRET);
            for (const { path, bytes } of filesUnder(secretsDirOf(baseDir))) {
              assert.isFalse(bytes.includes(Buffer.from(SECRET)), `${path} holds the value`);
              assert.isFalse(bytes.includes(Buffer.from(random)), `${path} holds the random key`);
            }
          }),
        );
      }),
    );

    it.effect("an entry moved to another name does not open", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) =>
          Effect.gen(function* () {
            yield* store.set("owner-token", encoder.encode(SECRET));
            NodeFS.copyFileSync(
              NodePath.join(secretsDirOf(baseDir), "owner-token.bin"),
              NodePath.join(secretsDirOf(baseDir), "guest-token.bin"),
            );
            const moved = yield* Effect.exit(store.get("guest-token"));
            assert.isTrue(Exit.isFailure(moved), "a renamed entry opened");
          }),
        );
      }),
    );

    it.effect("two writes of the same value never share bytes", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) =>
          Effect.gen(function* () {
            yield* store.set("a", encoder.encode(SECRET));
            const first = NodeFS.readFileSync(NodePath.join(secretsDirOf(baseDir), "a.bin"));
            yield* store.set("a", encoder.encode(SECRET));
            const second = NodeFS.readFileSync(NodePath.join(secretsDirOf(baseDir), "a.bin"));
            assert.notDeepEqual(first, second);
          }),
        );
      }),
    );
  });

  describe("the master key", () => {
    it.effect("is created on first start, owner-only, outside the secrets folder", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
        const keyFile = keyFileOf(baseDir);
        assert.isTrue(NodeFS.existsSync(keyFile));
        if ((yield* HostProcess.Platform) !== "win32") {
          assert.equal(NodeFS.statSync(keyFile).mode & 0o777, 0o600);
        }
        const text = NodeFS.readFileSync(keyFile, "utf8").trim();
        assert.match(text, /^t3-master-key-v1:[A-Za-z0-9_-]{43}$/);
      }),
    );

    it.effect("missing, with encrypted secrets, stops the store and is never created anew", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
        NodeFS.rmSync(keyFileOf(baseDir));
        const before = filesUnder(secretsDirOf(baseDir));
        const exit = yield* Effect.exit(readAll(baseDir, ["a"]));
        assert.isTrue(Exit.isFailure(exit), "the store started without its key");
        assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "t3 secrets key import");
        assert.isFalse(NodeFS.existsSync(keyFileOf(baseDir)), "a new key was created");
        assert.deepEqual(filesUnder(secretsDirOf(baseDir)), before);
      }),
    );

    it.effect("wrong, stops the store and leaves the key and every entry as they were", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
        const other = newBaseDir();
        yield* withStore(other, (store) => store.set("b", encoder.encode("x")));
        const wrongKey = NodeFS.readFileSync(keyFileOf(other));
        NodeFS.writeFileSync(keyFileOf(baseDir), wrongKey, { mode: 0o600 });
        const before = filesUnder(secretsDirOf(baseDir));
        const exit = yield* Effect.exit(readAll(baseDir, ["a"]));
        assert.isTrue(Exit.isFailure(exit), "the store started with another key");
        assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "master key");
        assert.deepEqual(NodeFS.readFileSync(keyFileOf(baseDir)), wrongKey);
        assert.deepEqual(filesUnder(secretsDirOf(baseDir)), before);
      }),
    );

    it.effect("readable by others, is refused until only its owner may read it", () =>
      Effect.gen(function* () {
        // Windows: mode bits mean nothing; the file inherits its folder's ACL.
        if ((yield* HostProcess.Platform) === "win32") return;
        const baseDir = newBaseDir();
        yield* withStore(baseDir, (store) => store.set("a", encoder.encode(SECRET)));
        NodeFS.chmodSync(keyFileOf(baseDir), 0o644);
        const exit = yield* Effect.exit(readAll(baseDir, ["a"]));
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "chmod 600");
        NodeFS.chmodSync(keyFileOf(baseDir), 0o600);
        const [value] = yield* readAll(baseDir, ["a"]);
        assert.equal(Option.getOrThrow(value!), SECRET);
      }),
    );
  });

  describe("a store from before encryption", () => {
    it.effect("is encrypted once at startup, values unchanged", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        seedPlaintext(baseDir, { "session-signing-key": SECRET, "ssh-install-key-1": "PRIVATE" });
        const values = yield* readAll(baseDir, ["session-signing-key", "ssh-install-key-1"]);
        assert.deepEqual(values.map(Option.getOrThrow), [SECRET, "PRIVATE"]);
        for (const { path, bytes } of filesUnder(secretsDirOf(baseDir))) {
          assert.isFalse(bytes.includes(Buffer.from(SECRET)), `${path} still in clear`);
          assert.isFalse(bytes.includes(Buffer.from("PRIVATE")), `${path} still in clear`);
        }
        // Idempotent: a second start rewrites nothing.
        const after = filesUnder(secretsDirOf(baseDir));
        yield* readAll(baseDir, ["session-signing-key"]);
        assert.deepEqual(filesUnder(secretsDirOf(baseDir)), after);
      }),
    );

    it.effect("stopped half-way, keeps every value readable and the next start finishes", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        seedPlaintext(baseDir, { one: "VALUE-ONE", two: "VALUE-TWO", three: "VALUE-THREE" });
        const crashed = yield* Effect.exit(
          withStore(baseDir, () => Effect.void, layerRenameFailsFrom(2)),
        );
        assert.isTrue(Exit.isFailure(crashed), "the startup did not stop where it crashed");
        const values = yield* readAll(baseDir, ["one", "two", "three"]);
        assert.deepEqual(values.map(Option.getOrThrow), ["VALUE-ONE", "VALUE-TWO", "VALUE-THREE"]);
        for (const { path, bytes } of filesUnder(secretsDirOf(baseDir))) {
          assert.isFalse(bytes.includes(Buffer.from("VALUE-")), `${path} still in clear`);
        }
      }),
    );
  });

  describe("a joined machine", () => {
    it.effect("keeps its credential as its Hub wrote it, with no master key", () =>
      Effect.gen(function* () {
        const baseDir = newBaseDir();
        seedPlaintext(baseDir, { "environment-credential": "joined-credential" });
        NodeFS.writeFileSync(NodePath.join(stateDirOf(baseDir), "joined-hub.json"), "{}");
        const [value] = yield* readAll(baseDir, ["environment-credential"]);
        assert.equal(Option.getOrThrow(value!), "joined-credential");
        assert.equal(
          NodeFS.readFileSync(
            NodePath.join(secretsDirOf(baseDir), "environment-credential.bin"),
            "utf8",
          ),
          "joined-credential",
        );
        assert.isFalse(NodeFS.existsSync(keyFileOf(baseDir)));
      }),
    );
  });
});
