// @effect-diagnostics nodeBuiltinImport:off - the test computes the folder name as the Hub does.
import * as NodeCrypto from "node:crypto";

import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  OrchestratorMcpRequestSecretInput,
  ProjectId,
  type OrchestrationV2ServerCommand,
  SecretRef,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Tracer from "effect/Tracer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type * as MasterKeyFile from "../auth/MasterKeyFile.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretFilesDirectory from "./SecretFilesDirectory.ts";
import * as SecretRequests from "./SecretRequests.ts";

const threadId = ThreadId.make("thread-orchestrator");
const turnItemId = TurnItemId.make("turn-item:secret-request:1");
const projectId = ProjectId.make("project-1");
const decodeSecretInput = Schema.decodeUnknownEffect(OrchestratorMcpRequestSecretInput);
const decodeSecretInputExit = Schema.decodeUnknownExit(OrchestratorMcpRequestSecretInput);

const withService = <A, E>(
  body: (input: {
    readonly service: SecretRequests.SecretRequests["Service"];
    readonly stored: Map<string, Uint8Array>;
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
  }) => Effect.Effect<A, E>,
  options: {
    readonly threadId?: ThreadId;
    readonly delivery?: "file";
    readonly directory?: string;
    /** Where file answers go; by default `<directory>/files`, `memory` finds the real one. */
    readonly filesIn?: "memory";
    /** A store's master key: answers are then kept sealed at rest. */
    readonly keyring?: MasterKeyFile.Keyring;
    readonly runStatus?: string;
    readonly removeFails?: boolean;
    readonly closedFirst?: boolean;
    readonly failedRecords?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    let secretStatus = "pending";
    let failedRecords = options.failedRecords ?? 0;
    const requestThreadId = options.threadId ?? threadId;
    const layerDependencies = Layer.mergeAll(
      PlatformNodeCrypto.layer,
      NodeServices.layer,
      options.keyring === undefined
        ? Layer.empty
        : Layer.succeed(ServerSecretStore.MasterKeyring, {
            keyring: Option.some(options.keyring),
            unavailable: Option.none(),
          }),
      options.directory === undefined || options.filesIn === "memory"
        ? Layer.empty
        : Layer.succeed(SecretFilesDirectory.SecretFilesDirectory, {
            directory: `${options.directory}/files`,
          }),
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          ...(options.directory === undefined ? {} : { directory: options.directory }),
          get: (name) => Effect.yieldNow.pipe(Effect.as(Option.fromNullishOr(stored.get(name)))),
          set: (name, value) => Effect.sync(() => void stored.set(name, value)),
          create: (name, value) =>
            stored.has(name)
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "AlreadyExists",
                        module: "FileSystem",
                        method: "open",
                      }),
                    ),
                  } as never),
                )
              : Effect.sync(() => void stored.set(name, value)),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const existing = stored.get(name);
              if (existing) return existing;
              const value = new Uint8Array(bytes).fill(7);
              stored.set(name, value);
              return value;
            }),
          remove: (name) =>
            options.removeFails
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new Error("read-only"),
                  }),
                )
              : Effect.sync(() => void stored.delete(name)),
        }),
      ),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        authorizeThread: () => Effect.void,
        getThreadRecords: () =>
          Effect.succeed({
            thread: { projectId },
            runs: [{ id: "run-1", status: options.runStatus ?? "running" }],
            turnItems: [
              {
                id: turnItemId,
                threadId: requestThreadId,
                runId: "run-1",
                nodeId: "node-root",
                type: "secret_request",
                label: "GitHub token",
                reason: "Used as GH_TOKEN.",
                ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
                secretStatus,
              },
            ],
          } as never),
        dispatch: (command) => {
          if (command.type === "secret_request.record" && failedRecords > 0) {
            failedRecords -= 1;
            return Effect.fail(new Error("orchestrator unavailable") as never);
          }
          return Effect.sync(() => {
            dispatched.push(command);
            if (options.closedFirst && command.type === "secret_request.record") {
              secretStatus = "cancelled";
            } else if (command.type === "secret_request.record" && secretStatus === "pending") {
              secretStatus = command.secretStatus;
            }
            return {} as never;
          });
        },
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* SecretRequests.SecretRequests;
      return yield* body({ service, stored, dispatched });
    }).pipe(Effect.provide(SecretRequests.layer.pipe(Layer.provide(layerDependencies))));
  });

/** A real master key, from a store of its own. */
const realKeyring = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-key-" });
  return yield* Effect.flatMap(ServerSecretStore.MasterKeyring, ({ keyring }) =>
    Effect.succeed(Option.getOrThrow(keyring)),
  ).pipe(
    Effect.provide(
      ServerSecretStore.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        Layer.provideMerge(PlatformNodeCrypto.layer),
      ),
    ),
  );
});

const valuesOf = (stored: Map<string, Uint8Array>) =>
  Array.from(stored.entries())
    .filter(([name]) => name !== "secret-request-salt")
    .map(([, bytes]) => new TextDecoder().decode(bytes));

it.effect("a saved answer becomes a one-use ref, and the thread only learns it was saved", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      assert.equal(dispatched.length, 1);
      assert.include(dispatched[0] as object, {
        type: "secret_request.record",
        secretStatus: "saved",
      });
      assert.notInclude(Object.values(dispatched[0] as object).map(String), "ghp_secret");

      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      const again = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
      assert.include(again.message, "already used");
    }),
  ),
);

it.effect("two concurrent uses of one ref hand the value out once", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      const results = yield* Effect.forEach(
        [service.consume({ ref, projectId }), service.consume({ ref, projectId })],
        Effect.result,
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results.map((result) => result._tag).toSorted(), ["Failure", "Success"]);
    }),
  ),
);

it.effect("a save that loses to the card closing deletes the value and says so", () =>
  withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(error.reason, "agent_stopped");
        assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      }),
    { closedFirst: true },
  ),
);

it.effect("a save whose record failed can be saved again", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const failed = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(failed.reason, "record_failed");
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { failedRecords: 1 },
  ),
);

it.effect("a ref only works in the project it was entered for", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      const elsewhere = yield* service
        .consume({ ref, projectId: ProjectId.make("project-other") })
        .pipe(Effect.flip);
      assert.include(elsewhere.message, "does not exist");
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
    }),
  ),
);

it.effect("declining stores nothing, and a request is answered once", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
      assert.deepEqual(valuesOf(stored), []);
      assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
      const late = yield* service
        .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
        .pipe(Effect.flip);
      assert.include(late.message, "already answered");
      assert.equal(dispatched.length, 1);
      assert.deepEqual(valuesOf(stored), []);
    }),
  ),
);

it.effect("traces and counts a saved answer without ever recording the value", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const counted = Metric.snapshot.pipe(
      Effect.map((snapshots) => {
        const found = snapshots.find(
          (snapshot) =>
            snapshot.id === "t3_secret_refs_consumed_total" &&
            snapshot.attributes?.result === "used",
        );
        return found?.type === "Counter" ? Number(found.state.count) : 0;
      }),
    );
    const before = yield* counted;
    yield* withService(({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        yield* service.consume({ ref, projectId });
      }),
    ).pipe(Effect.withTracer(tracer));
    assert.equal((yield* counted) - before, 1);
    const recorded = spans.flatMap((span) => [
      span.name,
      ...Array.from(span.attributes.values(), String),
    ]);
    assert.include(recorded, "SecretRequests.answer");
    assert.include(recorded, "SecretRequests.consume");
    assert.isFalse(recorded.some((value) => value.includes("ghp_secret")));
  }),
);

it.effect("works in threads with long ids, such as a delegated subagent's", () => {
  const delegatedThreadId = ThreadId.make(
    `thread:delegated-task:command%3Amcp%3A${"a".repeat(36)}%3Adelegate-task%3Arelease-notes-v0.2.0-${"b".repeat(40)}`,
  );
  return withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId: delegatedThreadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        assert.isTrue(Array.from(stored.keys()).every((name) => name.length < 100));
        const ref = Option.getOrThrow(
          yield* service.savedRef({ threadId: delegatedThreadId, turnItemId }),
        );
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { threadId: delegatedThreadId },
  );
});

it.effect("refuses an answer once the agent that asked has stopped", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        const late = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.include(late.message, "has stopped");
        assert.deepEqual(valuesOf(stored), []);
        assert.equal(dispatched.length, 0);
      }),
    { runStatus: "completed" },
  ),
);

it.effect("a used value that cannot be deleted is not handed out", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const failed = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
        assert.include(failed.message, "Could not use");
      }),
    { removeFails: true },
  ),
);

const SECRET_FILE_TTL_MS = 24 * 60 * 60 * 1000;

it.effect("a file request moves its value to an owner-only file, once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const file = yield* withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token'$(id)" },
          });
          assert.include(dispatched[0] as object, { secretStatus: "saved", delivery: "file" });
          const file = yield* service.saveToFile({ threadId, turnItemId });
          assert.equal(yield* fs.readFileString(file), "cf_token'$(id)");
          assert.deepEqual(valuesOf(stored), []);
          if ((yield* HostProcess.Platform) !== "win32") {
            assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
            assert.equal((yield* fs.stat(path.dirname(file))).mode & 0o777, 0o700);
          }
          // A retried request_secret gets the same file; the value is never a ref again.
          assert.equal(yield* service.saveToFile({ threadId, turnItemId }), file);
          const ref = SecretRef.make(`secret-ref:${path.basename(file)}`);
          const reused = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
          assert.equal(reused.reason, "ref_unavailable");
          return file;
        }),
      { delivery: "file", directory },
    );

    const { mtime } = yield* fs.stat(file);
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS);
    yield* withService(() => Effect.void, { directory });
    assert.isTrue(yield* fs.exists(file));
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS + 1);
    yield* withService(() => Effect.void, { directory });
    assert.isFalse(yield* fs.exists(file));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a file answer is sealed at rest and in clear only in memory, and comes back", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    // Stands for the user's runtime folder in memory (owner-only, as systemd makes it).
    const runtime = yield* fs.makeTempDirectoryScoped({ prefix: "secret-runtime-test-" });
    yield* fs.chmod(runtime, 0o700);
    const keyring = yield* realKeyring;
    // An answer an earlier version left in clear on the disk.
    const legacyName = "0123456789abcdef0123456789abcdef";
    yield* fs.makeDirectory(path.join(directory, "files"), { recursive: true });
    yield* fs.writeFileString(path.join(directory, "files", legacyName), "legacy-answer-77");
    const options = { delivery: "file" as const, directory, filesIn: "memory" as const, keyring };
    const inMemory = Effect.provideService(HostProcess.Environment, { XDG_RUNTIME_DIR: runtime });
    const file = yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token-on-disk-check" },
          });
          return yield* service.saveToFile({ threadId, turnItemId });
        }),
      options,
    ).pipe(inMemory);
    assert.equal(yield* fs.readFileString(file), "cf_token-on-disk-check");
    assert.isFalse(file.startsWith(directory), "the answer was written under the secrets folder");
    const id = path.basename(file);
    for (const sealed of [id, legacyName]) {
      assert.isTrue(yield* fs.exists(path.join(directory, "files", `${sealed}.sealed`)));
    }
    const onDisk = (yield* fs.readDirectory(directory, { recursive: true })).map((name) =>
      path.join(directory, name),
    );
    for (const entry of onDisk) {
      if ((yield* fs.stat(entry)).type !== "File") continue;
      const text = yield* fs.readFileString(entry);
      assert.notInclude(text, "cf_token-on-disk-check", `${entry} holds the answer`);
      assert.notInclude(text, "legacy-answer-77", `${entry} still holds an old answer`);
    }
    // A restart empties memory, and leaves a stale file there: the next start removes the
    // orphan, and a retry brings the answer back from its sealed copy.
    yield* fs.remove(file);
    yield* fs.writeFileString(path.join(runtime, path.basename(path.dirname(file)), "stale"), "x");
    const again = yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          // The Thread still records the answer as saved (this test double starts over).
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "other" },
          });
          return yield* service.saveToFile({ threadId, turnItemId });
        }),
      options,
    ).pipe(inMemory);
    assert.equal(again, file);
    // The sealed copy, not a new answer: a command holding the path never reads another value.
    assert.equal(yield* fs.readFileString(again), "cf_token-on-disk-check");
    assert.isFalse(yield* fs.exists(path.join(path.dirname(file), "stale")));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a planted symlink where the folder in memory goes is never used", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const secretsDir = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const runtime = yield* fs.makeTempDirectoryScoped({ prefix: "secret-runtime-test-" });
    const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "secret-elsewhere-test-" });
    yield* fs.chmod(runtime, 0o700);
    yield* fs.chmod(elsewhere, 0o700);
    const name = `t3code-secret-files-${NodeCrypto.createHash("sha256").update(secretsDir).digest("hex").slice(0, 16)}`;
    yield* fs.symlink(elsewhere, path.join(runtime, name));
    const resolved = yield* SecretFilesDirectory.resolveSecretFilesDirectory(secretsDir).pipe(
      Effect.provideService(HostProcess.Environment, {
        XDG_RUNTIME_DIR: runtime,
        T3CODE_SHM_DIR: path.join(runtime, "no-shm"),
      }),
    );
    const found = Option.getOrUndefined(resolved) as unknown;
    const directory =
      typeof found === "string" ? found : (found as { directory?: string } | undefined)?.directory;
    assert.notEqual(directory, path.join(runtime, name), "the planted symlink was used");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("without a folder in memory a pasted secret still reaches the agent, from disk", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const keyring = yield* realKeyring;
    const noMemory = Effect.provideService(HostProcess.Environment, {
      T3CODE_SHM_DIR: path.join(directory, "no-shm"),
    });
    const options = { directory, filesIn: "memory" as const, keyring };
    const paste = withService(
      ({ service }) =>
        service.savePasted({
          threadId,
          requestNamespace: "session-a",
          requestKey: "key-1",
          value: "pasted-on-desktop-31",
        }),
      options,
    ).pipe(noMemory);
    const file = yield* paste;
    assert.equal(yield* fs.readFileString(file), "pasted-on-desktop-31");
    if ((yield* HostProcess.Platform) !== "win32") {
      assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
      assert.equal((yield* fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    }
    // The next start removes the copy in clear; the answer comes back from its sealed copy.
    yield* withService(() => Effect.void, options).pipe(noMemory);
    assert.isFalse(yield* fs.exists(file));
    const again = yield* paste;
    assert.equal(again, file);
    assert.equal(yield* fs.readFileString(again), "pasted-on-desktop-31");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("one bad old answer never stops the others from being sealed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const runtime = yield* fs.makeTempDirectoryScoped({ prefix: "secret-runtime-test-" });
    yield* fs.chmod(runtime, 0o700);
    const keyring = yield* realKeyring;
    const files = path.join(directory, "files");
    yield* fs.makeDirectory(files, { recursive: true });
    // Sorted first: a dangling symlink, then a live answer left in clear.
    yield* fs.symlink(
      path.join(directory, "gone"),
      path.join(files, "00000000000000000000000000000000"),
    );
    yield* fs.writeFileString(
      path.join(files, "0123456789abcdef0123456789abcdef"),
      "old-answer-91",
    );
    yield* withService(() => Effect.void, { directory, filesIn: "memory", keyring }).pipe(
      Effect.provideService(HostProcess.Environment, { XDG_RUNTIME_DIR: runtime }),
    );
    const names = (yield* fs.readDirectory(files)).toSorted();
    assert.deepEqual(names, ["0123456789abcdef0123456789abcdef.sealed"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a failed file write keeps the value, so the request can retry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token" },
          });
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          const name = ref.slice("secret-ref:".length);
          // A non-empty directory where the partial file goes makes the write fail.
          const partial = path.join(directory, "files", `${name}.partial`);
          yield* fs.makeDirectory(path.join(partial, "block"), { recursive: true });
          const failed = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(failed.reason, "store_failed");
          yield* fs.remove(partial, { recursive: true });
          const file = yield* service.saveToFile({ threadId, turnItemId });
          assert.equal(yield* fs.readFileString(file), "cf_token");
        }),
      { delivery: "file", directory },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a file is not delivered while its stored copy cannot be removed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token" },
          });
          const first = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(first.reason, "consume_failed");
          // A retry finds the file but still will not hand it out until the removal works.
          const retried = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(retried.reason, "consume_failed");
        }),
      { delivery: "file", directory, removeFails: true },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a secret the card promised to keep from the agent is never written to a file", () =>
  withService(({ service, stored }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const refused = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
      assert.equal(refused.reason, "not_a_file_request");
      assert.isTrue(valuesOf(stored).some((value) => value.includes("ghp_secret")));
    }),
  ),
);

it.effect("a pasted secret goes straight to an owner-only file, with no card", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const pasted = "4829'$(id) 16";
    const file = yield* withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          const file = yield* service.savePasted({
            threadId,
            requestNamespace: "session-a",
            requestKey: "key-1",
            value: pasted,
          });
          assert.equal(path.dirname(file), path.join(directory, "files"));
          assert.match(path.basename(file), /^[0-9a-f]{32}$/);
          assert.equal(yield* fs.readFileString(file), pasted);
          if ((yield* HostProcess.Platform) !== "win32") {
            assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
            assert.equal((yield* fs.stat(path.dirname(file))).mode & 0o777, 0o700);
          }
          // No card and no stored copy: the thread never hears of it.
          assert.deepEqual(dispatched, []);
          assert.deepEqual(valuesOf(stored), []);
          // A retry with the same key gets the same file, unchanged even if the value differs.
          assert.equal(
            yield* service.savePasted({
              threadId,
              requestNamespace: "session-a",
              requestKey: "key-1",
              value: "other",
            }),
            file,
          );
          assert.equal(yield* fs.readFileString(file), pasted);
          // Another key, or the same key from another provider session, gets its own file.
          const other = yield* service.savePasted({
            threadId,
            requestNamespace: "session-a",
            requestKey: "key-2",
            value: "x",
          });
          assert.notEqual(other, file);
          const otherSession = yield* service.savePasted({
            threadId,
            requestNamespace: "session-b",
            requestKey: "key-1",
            value: "y",
          });
          assert.notEqual(otherSession, file);
          assert.equal(yield* fs.readFileString(file), pasted);
          // Its name is not a ref to the value.
          const ref = SecretRef.make(`secret-ref:${path.basename(file)}`);
          const reused = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
          assert.equal(reused.reason, "ref_unavailable");
          return file;
        }).pipe(Effect.withTracer(tracer)),
      { directory },
    );
    const recorded = spans.flatMap((span) => [
      span.name,
      ...Array.from(span.attributes.values(), String),
    ]);
    assert.include(recorded, "SecretRequests.savePasted");
    assert.isFalse(recorded.some((value) => value.includes("4829")));

    const { mtime } = yield* fs.stat(file);
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS);
    yield* withService(() => Effect.void, { directory });
    assert.isTrue(yield* fs.exists(file));
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS + 1);
    yield* withService(() => Effect.void, { directory });
    assert.isFalse(yield* fs.exists(file));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a pasted secret keeps its exact bytes from the tool input to the file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const pasted = "  pa ss\tword\t ";
    const input = yield* decodeSecretInput({
      label: "Staging password",
      reason: "Signs in the QA account.",
      value: pasted,
    });
    assert.equal(input.value, pasted);
    const empty = decodeSecretInputExit({
      label: "Staging password",
      reason: "Signs in the QA account.",
      value: "",
    });
    assert.isTrue(Exit.isFailure(empty));
    const file = yield* withService(
      ({ service }) =>
        service.savePasted({
          threadId,
          requestNamespace: "session-a",
          requestKey: "key-1",
          value: input.value!,
        }),
      { directory },
    );
    assert.equal(yield* fs.readFileString(file), pasted);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a pasted secret is refused without a secrets directory", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      const failed = yield* service
        .savePasted({ threadId, requestNamespace: "session-a", requestKey: "key-1", value: "4829" })
        .pipe(Effect.flip);
      assert.equal(failed.reason, "store_failed");
    }),
  ),
);
