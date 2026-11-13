/**
 * Spec 5 ticket 05: the masker where text arrives in pieces (terminal frames, command output
 * chunks) and where events are stored. The forms of a value (URL-encoded, base64, overlapping
 * values) are `packages/shared/src/secretMasking.test.ts`; the whole Hub is
 * `HubWithEnvironments.secretMasking.test.ts`.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  type TerminalAttachStreamEvent,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeSecretPatterns } from "@t3tools/shared/secretMasking";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  type TerminalOutputState,
} from "@t3tools/shared/terminalOutput";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { maskTerminalStream } from "./maskTerminal.ts";
import * as SecretMasker from "./SecretMasker.ts";

const TOKEN = "sk-live-7f3a9c2e1b";

const fakeMasker = SecretMasker.SecretMasker.of({
  forThread: () =>
    Effect.succeed(
      SecretMasker.threadMaskerOf(makeSecretPatterns([{ name: "API_TOKEN", value: TOKEN }])),
    ),
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
