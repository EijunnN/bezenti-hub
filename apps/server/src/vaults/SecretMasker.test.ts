/**
 * Spec 5 ticket 05: the masker where text arrives in pieces (terminal frames, command output
 * chunks) and where events are stored. The forms of a value (URL-encoded, base64, overlapping
 * values) are `packages/shared/src/secretMasking.test.ts`; the whole Hub is
 * `HubWithEnvironments.secretMasking.test.ts`.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type GitActionProgressEvent,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type TerminalAttachStreamEvent,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeSecretPatterns } from "@t3tools/shared/secretMasking";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  type TerminalOutputState,
} from "@t3tools/shared/terminalOutput";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import { maskingCheckoutReads } from "./maskCheckoutReads.ts";
import { maskGitProgress } from "./maskGitProgress.ts";
import { maskingPullRequestReads } from "./maskPullRequests.ts";
import { maskTerminalStream } from "./maskTerminal.ts";
import { maskReadFile, maskSearchContents } from "./maskWorkspace.ts";
import * as SecretMasker from "./SecretMasker.ts";

const TOKEN = "sk-live-7f3a9c2e1b";

const tokenMasker = SecretMasker.threadMaskerOf(
  makeSecretPatterns([{ name: "API_TOKEN", value: TOKEN }]),
);
const fakeMasker = SecretMasker.SecretMasker.of({
  forThread: () => Effect.succeed(tokenMasker),
  forThreads: () => Effect.succeed(tokenMasker),
  forCheckout: () => Effect.succeed(tokenMasker),
  forPullRequest: () => Effect.succeed(tokenMasker),
  remember: () => Effect.void,
});

const output = (data: string): TerminalAttachStreamEvent => ({
  type: "output",
  threadId: "thread-1",
  terminalId: "term-1",
  data,
});

const outputsOf = (events: ReadonlyArray<TerminalAttachStreamEvent>) =>
  events.flatMap((event) => (event.type === "output" ? [event.data] : []));

describe("SecretMasker: terminal frames", () => {
  it.live("masks a value split between two frames, sent as one frame", () =>
    Effect.gen(function* () {
      const events = yield* maskTerminalStream(
        fakeMasker,
        "thread-1",
        Stream.make(output(`out: ${TOKEN.slice(0, 5)}`), output(`${TOKEN.slice(5)}\r\n`)),
      ).pipe(Stream.runCollect);
      assert.deepEqual(outputsOf([...events]), ["out: [API_TOKEN]\r\n"]);
    }),
  );

  it.live("sends a frame that only looked like a value's start once nothing follows", () =>
    Effect.gen(function* () {
      const events = yield* maskTerminalStream(
        fakeMasker,
        "thread-1",
        Stream.concat(Stream.make(output("prompt sk-")), Stream.never),
      ).pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual(outputsOf([...events]), ["prompt sk-"]);
    }),
  );

  it.live("masks a snapshot's history and keeps frames in order around it", () =>
    Effect.gen(function* () {
      const events = yield* maskTerminalStream(
        fakeMasker,
        "thread-1",
        Stream.make(output(`a ${TOKEN.slice(0, 4)}`), {
          type: "snapshot",
          snapshot: {
            threadId: "thread-1",
            terminalId: "term-1",
            cwd: "/work",
            worktreePath: null,
            status: "running",
            pid: 1,
            history: `$ echo $API_TOKEN\r\n${TOKEN}\r\n`,
            exitCode: null,
            exitSignal: null,
            label: "shell",
            updatedAt: "2026-11-13T00:00:00.000Z",
          },
        } satisfies TerminalAttachStreamEvent),
      ).pipe(Stream.runCollect);
      const [first, second] = [...events];
      assert.deepEqual(first, output(`a ${TOKEN.slice(0, 4)}`));
      assert.equal(
        second?.type === "snapshot" ? second.snapshot.history : undefined,
        "$ echo $API_TOKEN\r\n[API_TOKEN]\r\n",
      );
    }),
  );
});

// ── Command output and stored events: the real EventSink and CommandOutputHub ────────────────

const layerDatabase = SqlitePersistence.layerMemory;
const layerStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerDatabase),
);
const layerMasker = Layer.succeed(SecretMasker.SecretMasker, fakeMasker);
const layerEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerStores, layerDatabase, layerMasker)),
);
const layerTest = Layer.mergeAll(
  layerEventSink,
  layerStores,
  layerDatabase,
  IdAllocator.layer,
  CommandOutputHub.layer.pipe(
    Layer.provide(Layer.mergeAll(layerEventSink, layerStores, layerMasker)),
  ),
);

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const ITEM_ID = TurnItemId.make("turn-item:command");

const seedThread = Effect.gen(function* () {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const projectId = yield* idAllocator.allocate.project({ fixtureName: "masking" });
  const threadId = yield* idAllocator.allocate.thread({ fixtureName: "masking", projectId });
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: `Uses ${TOKEN}`,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    branchPullRequest: null,
    activeOrderKey: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* eventSink.write({
    events: [
      {
        id: yield* idAllocator.allocate.event({ threadId }),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
  return threadId;
});

const writeCommandItem = (threadId: ThreadId, output: string | null) =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const item: OrchestrationV2TurnItem = {
      id: ITEM_ID,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "echo $API_TOKEN",
      status: "running",
      ...(output === null ? {} : { output }),
    };
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId }),
          type: "turn-item.updated",
          threadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: item,
        },
      ],
    });
  });

const applyFrame = (state: TerminalOutputState, frame: OrchestrationV2CommandOutputFrame) =>
  frame.kind === "replace"
    ? appendTerminalOutput({ ...EMPTY_TERMINAL_OUTPUT, truncated: frame.truncated }, frame.text)
    : appendTerminalOutput(state, frame.text);

const databaseText = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `;
  let text = "";
  for (const { name } of tables) {
    text += JSON.stringify(yield* sql.unsafe(`SELECT * FROM "${name}"`));
  }
  return text;
});

describe("SecretMasker: stored events and live command output", () => {
  it.live("stores and projects every event with its values masked", () =>
    Effect.gen(function* () {
      const threadId = yield* seedThread;
      yield* writeCommandItem(threadId, `${TOKEN}\n`);
      const { turnItems } = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
        threadId,
        ["turnItems"],
      );
      const item = turnItems.find((candidate) => candidate.id === ITEM_ID);
      assert.equal(item?.type === "command_execution" ? item.output : undefined, "[API_TOKEN]\n");
      const thread = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(threadId);
      assert.equal(thread.title, "Uses [API_TOKEN]");
      const stored = yield* databaseText;
      assert.include(stored, "[API_TOKEN]");
      assert.notInclude(stored, TOKEN);
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("masks a value split between two chunks of live command output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* CommandOutputHub.CommandOutputHub;
        const threadId = yield* seedThread;
        yield* writeCommandItem(threadId, null);
        const frames = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame>();
        yield* hub.subscribe({ threadId, itemId: ITEM_ID }).pipe(
          Stream.runForEach((frame) => Queue.offer(frames, frame)),
          Effect.forkScoped,
        );
        yield* hub.append({ threadId, itemId: ITEM_ID, chunk: `out ${TOKEN.slice(0, 6)}` });
        yield* hub.append({ threadId, itemId: ITEM_ID, chunk: `${TOKEN.slice(6)} done\n` });
        let client = EMPTY_TERMINAL_OUTPUT;
        const seen: Array<string> = [];
        while (!client.text.includes("done")) {
          const frame = yield* Queue.take(frames);
          seen.push(frame.text);
          client = applyFrame(client, frame);
        }
        assert.equal(client.text, "out [API_TOKEN] done\n");
        assert.notInclude(seen.join(""), TOKEN.slice(6));
      }),
    ).pipe(Effect.provide(layerTest)),
  );
});

// ── Doors that are not events: each called with a secret, as MaskedPaths.ts names them ───────

const failingMasker = SecretMasker.SecretMasker.of({
  forThread: (threadId) => Effect.fail(new SecretMasker.SecretMaskingError({ threadId })),
  forThreads: () => Effect.fail(new SecretMasker.SecretMaskingError({})),
  forCheckout: () => Effect.fail(new SecretMasker.SecretMaskingError({})),
  forPullRequest: () => Effect.fail(new SecretMasker.SecretMaskingError({})),
  remember: () => Effect.void,
});

describe("SecretMasker: the doors that are not events", () => {
  it.live("masks a rejected command's error and the outbox's payloads", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = yield* seedThread;
      const receipt = yield* eventSink.commitRejectedCommand({
        commandId: CommandId.make("command:rejected"),
        threadId,
        commandType: "thread.turn.start",
        rejectedAt: yield* DateTime.now,
        error: `git push failed: remote said ${TOKEN}`,
      });
      assert.include(JSON.stringify(receipt), "[API_TOKEN]");
      yield* eventSink.writeWithEffects({
        events: [],
        effects: [
          {
            id: "effect:detach",
            commandId: CommandId.make("command:detach"),
            threadId,
            request: {
              type: "provider-session.detach",
              providerSessionId: ProviderSessionId.make("session:masking"),
              detail: `stopped with ${TOKEN}`,
            },
          },
        ],
      });
      const stored = yield* databaseText;
      assert.include(stored, "stopped with [API_TOKEN]");
      assert.notInclude(stored, TOKEN);
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("stores nothing when a Thread's values cannot be read", () =>
    Effect.gen(function* () {
      const write = yield* Effect.gen(function* () {
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectId = yield* idAllocator.allocate.project({ fixtureName: "closed" });
        const threadId = yield* idAllocator.allocate.thread({ fixtureName: "closed", projectId });
        return yield* eventSink
          .commitRejectedCommand({
            commandId: CommandId.make("command:closed"),
            threadId,
            commandType: "thread.turn.start",
            rejectedAt: yield* DateTime.now,
            error: `failed with ${TOKEN}`,
          })
          .pipe(Effect.exit);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            EventSink.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  layerStores,
                  layerDatabase,
                  Layer.succeed(SecretMasker.SecretMasker, failingMasker),
                ),
              ),
            ),
            IdAllocator.layer,
          ),
        ),
      );
      assert.isTrue(Exit.isFailure(write));
    }),
  );

  it.effect("masks setup-script output before a client sees it", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const threadId = ThreadId.make("thread:setup");
      yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["setup-script"],
        fiber: null,
      });
      yield* tracker.appendTail(threadId, "setup-script", `export TOKEN=${TOKEN}`);
      yield* tracker.stageStatus(threadId, "setup-script", "failed", `exit 1: ${TOKEN}`);
      const snapshot = JSON.stringify(yield* tracker.get(threadId));
      assert.include(snapshot, "export TOKEN=[API_TOKEN]");
      assert.notInclude(snapshot, TOKEN);
    }).pipe(Effect.provide(WorktreeSetupTracker.layer.pipe(Layer.provide(layerMasker)))),
  );

  it.effect("masks every answer about a change request with its linked Threads' values", () =>
    Effect.gen(function* () {
      const service = maskingPullRequestReads(Option.some(fakeMasker), {
        diffFileContents: (_input: { readonly repository: string; readonly number: number }) =>
          Effect.succeed({ oldContents: "", newContents: `TOKEN=${TOKEN}\n` }),
      });
      const answer = yield* service.diffFileContents({ repository: "acme/web", number: 7 });
      assert.deepEqual(answer, { oldContents: "", newContents: "TOKEN=[API_TOKEN]\n" });
      const failing = maskingPullRequestReads(Option.some(failingMasker), {
        diff: (_input: { readonly repository: string; readonly number: number }) =>
          Effect.succeed(TOKEN),
      });
      const refused = yield* Effect.exit(failing.diff({ repository: "acme/web", number: 7 }));
      assert.isTrue(Exit.isFailure(refused), "nothing unmasked when the values cannot be read");
    }),
  );

  it.effect(
    "masks a checkout's diffs and commits with the values of the Threads that run there",
    () =>
      Effect.gen(function* () {
        const service = maskingCheckoutReads(Option.some(fakeMasker), {
          getDiffPreview: (_input: { readonly cwd: string }) =>
            Effect.succeed({ sources: [{ diff: `+TOKEN=${TOKEN}` }] }),
        });
        const answer = yield* service.getDiffPreview({ cwd: "/work/acme" });
        assert.deepEqual(answer, { sources: [{ diff: "+TOKEN=[API_TOKEN]" }] });
      }),
  );

  it.effect("masks git hook output with the Thread's values, or sends none", () =>
    Effect.gen(function* () {
      const published: Array<unknown> = [];
      const reporter = {
        publish: (event: GitActionProgressEvent) =>
          Effect.sync(() => {
            published.push(event);
          }),
      };
      const hookLine = {
        actionId: "action-1",
        cwd: "/work/acme",
        action: "commit",
        kind: "hook_output",
        hookName: "pre-commit",
        stream: "stdout",
        text: `checking ${TOKEN}`,
      } as unknown as GitActionProgressEvent;
      const masked = yield* maskGitProgress(
        Option.some(fakeMasker),
        { cwd: "/work/acme", threadId: ThreadId.make("thread:git") },
        { progressReporter: reporter },
      );
      yield* masked!.progressReporter!.publish(hookLine);
      const closed = yield* maskGitProgress(
        Option.some(failingMasker),
        { cwd: "/work/acme" },
        { progressReporter: reporter },
      );
      yield* closed!.progressReporter!.publish(hookLine);
      assert.lengthOf(published, 1);
      assert.include(JSON.stringify(published[0]), "checking [API_TOKEN]");
    }),
  );

  it.effect("masks the continuation of a value whose frames came apart past the hold", () =>
    Effect.gen(function* () {
      const frames = yield* Queue.unbounded<TerminalAttachStreamEvent, Cause.Done>();
      const collected = yield* maskTerminalStream(
        fakeMasker,
        "thread-1",
        Stream.fromQueue(frames),
      ).pipe(Stream.runCollect, Effect.forkScoped);
      yield* Queue.offer(frames, output(`out: ${TOKEN.slice(0, 5)}`));
      yield* TestClock.adjust("1 second");
      yield* Queue.offer(frames, output(`${TOKEN.slice(5)}\r\n`));
      yield* Queue.end(frames);
      const sent = outputsOf([...(yield* Fiber.join(collected))]);
      assert.deepEqual(sent, [`out: ${TOKEN.slice(0, 5)}`, "[API_TOKEN]\r\n"]);
      assert.notInclude(sent.join(""), TOKEN.slice(5));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "drops a search match that could spell a value out, and says nothing more matched",
    () =>
      Effect.sync(() => {
        const cut = `${"x".repeat(512 - 4)}${TOKEN.slice(0, 4)}`;
        const result = maskSearchContents(tokenMasker, {
          matches: [
            { path: "a.txt", lineNumber: 1, lineContent: `k=${TOKEN}`, matchRanges: [] },
            { path: "b.txt", lineNumber: 1, lineContent: cut, matchRanges: [] },
            { path: "c.txt", lineNumber: 1, lineContent: "ordinary", matchRanges: [] },
          ],
          truncated: true,
        } as never);
        assert.deepEqual(
          result.matches.map((match) => match.path),
          ["c.txt"],
        );
        assert.isFalse(result.truncated);
        const read = maskReadFile(tokenMasker, {
          relativePath: "big.txt",
          contents: `head\n${TOKEN.slice(0, 6)}`,
          byteLength: 9_000_000,
          truncated: true,
        } as never);
        assert.equal(read.contents, "head\n");
      }),
  );
});
