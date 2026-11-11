import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  NodeId,
  SpaceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import { addMember } from "../auth/UserAuth.testkit.ts";
import * as RemoteEnvironments from "../environment/RemoteEnvironments.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as CheckpointUploadService from "../orchestration-v2/CheckpointUploadService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import {
  connectProtocolEnvironment,
  makeHub,
  seedProject,
  type Hub,
  type TestEnvironment,
} from "./HubWithEnvironments.testkit.ts";
import {
  CLAUDE,
  idleAdapters,
  loadFixture,
  replayOn,
  ownerIdOf,
  openProtocolSession,
  git,
  awaitUploaded,
  withEditingTurns,
} from "./HubWithEnvironments.scenarios.testkit.ts";

/** Ready checkpoints of a Thread (turns 1..count) that the Hub repository does not have yet. */
const seedCheckpoints = Effect.fn(function* (hub: Hub, threadId: ThreadId, count: number) {
  const projection = yield* hub
    .service(Orchestrator.OrchestratorV2)
    .getThreadProjection(threadId)
    .pipe(Effect.orDie);
  const now = projection.thread.createdAt;
  const scopeId = CheckpointScopeId.make("scope:protocol");
  const nodeId = NodeId.make("node:protocol");
  const seeded = Array.from({ length: count }, (_, index) => ({
    ordinal: index + 1,
    ref: CheckpointRef.make(`refs/t3/orchestration-v2/checkpoints/protocol/ordinal/${index + 1}`),
    checkpointId: CheckpointId.make(`checkpoint:protocol:${index + 1}`),
  }));
  yield* hub.server.eventSink
    .write({
      events: [
        {
          id: EventId.make("event:protocol-scope"),
          type: "checkpoint-scope.created",
          threadId,
          occurredAt: now,
          payload: {
            id: scopeId,
            threadId,
            runId: null,
            nodeId,
            parentScopeId: null,
            providerThreadId: null,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/remote/projects/protocol",
            createdAt: now,
          },
        },
        ...seeded.map((checkpoint) => ({
          id: EventId.make(`event:protocol-checkpoint:${checkpoint.ordinal}`),
          type: "checkpoint.captured" as const,
          threadId,
          occurredAt: now,
          payload: {
            id: checkpoint.checkpointId,
            threadId,
            scopeId,
            runId: null,
            nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: checkpoint.ordinal,
            appRunOrdinal: checkpoint.ordinal,
            ref: checkpoint.ref,
            status: "ready" as const,
            files: [],
            capturedAt: now,
            uploadedToHub: false,
          },
        })),
      ],
    })
    .pipe(Effect.orDie);
  return seeded as [(typeof seeded)[number], ...typeof seeded];
});

/** The machine answers the Hub's next request, which must be `method` with `payload`. */
const answerNext = Effect.fn(function* (
  machine: {
    readonly nextFrame: Effect.Effect<Record<string, unknown>>;
    readonly connection: RemoteEnvironments.RemoteConnection;
  },
  method: string,
  payload: unknown,
  result:
    | { readonly _tag: "success"; readonly value: unknown }
    | { readonly _tag: "failure"; readonly error: unknown },
) {
  const frame = yield* machine.nextFrame;
  assert.deepEqual({ method: frame.method, payload: frame.payload }, { method, payload });
  yield* machine.connection.receive({ type: "response", requestId: frame.requestId, result });
});

const PUSH_FAILED = {
  _tag: "failure",
  error: {
    _tag: "VcsProcessExitError",
    operation: "HubRepository.push",
    command: "git push",
    cwd: "/remote/projects/protocol",
    exitCode: 1,
    detail: "src refspec does not match any",
  },
} as const;

describe("Hub repository", () => {
  it.live(
    "an Environment reaches the repositories of Projects its owner works in, until removed",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: idleAdapters(ProviderInstanceId.make("claudeAgent")),
        });
        const own = ProjectId.make("project:own");
        const { workspaceRoot } = yield* seedProject(hub.server, {
          projectId: own,
          title: "Own",
          defaultModelSelection: null,
        });
        yield* addMember(hub.server, { id: "member-1", displayName: "Grace Hopper" });
        const others = ProjectId.make("project:graces");
        yield* seedProject(hub.server, {
          projectId: others,
          title: "Grace's",
          defaultModelSelection: null,
          spaceId: SpaceId.make("personal:member-1"),
        });
        const ref = CheckpointRef.make("refs/t3/orchestration-v2/checkpoints/test/ordinal/1");
        yield* git(workspaceRoot, ["update-ref", ref, "HEAD"]);
        const remote = (projectId: ProjectId) =>
          HubRepository.withEnvironmentCredential(
            HubRepository.hubRepositoryUrl(hub.server.url, { projectId }),
            laptop.credential,
          );
        const push = (projectId: ProjectId) =>
          git(workspaceRoot, ["push", remote(projectId).url, `${ref}:${ref}`], {
            env: remote(projectId).env ?? {},
          });
        const advertised = (projectId: ProjectId, credential = laptop.credential) =>
          HttpClient.HttpClient.pipe(
            Effect.flatMap((client) =>
              client.execute(
                HttpClientRequest.get(
                  `${remote(projectId).url}/info/refs?service=git-upload-pack`,
                ).pipe(HttpClientRequest.bearerToken(credential)),
              ),
            ),
            Effect.map((response) => response.status),
            Effect.provide(FetchHttpClient.layer),
            Effect.orDie,
          );

        // Its own Project: it may fetch (which refs it may see is the next test's).
        const listed = yield* git(workspaceRoot, ["ls-remote", remote(own).url], {
          env: remote(own).env ?? {},
        });
        assert.equal(listed.exitCode, 0);
        assert.equal(yield* advertised(own), 200);

        // Another User's Space: the Owner's machine neither reads nor writes its Project.
        assert.equal(yield* advertised(others), 403);
        assert.notEqual((yield* push(others)).exitCode, 0);
        assert.equal(yield* advertised(own, "not-a-credential"), 401);

        // Removed: push and fetch stop at once.
        const owner = yield* ownerIdOf(hub);
        yield* hub
          .service(EnvironmentRegistry.EnvironmentRegistry)
          .remove({ actorUserId: owner, environmentId: laptop.environmentId });
        assert.equal(yield* advertised(own), 401);
        assert.notEqual(
          (yield* git(workspaceRoot, ["ls-remote", remote(own).url], {
            env: remote(own).env ?? {},
          })).exitCode,
          0,
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "a turn's checkpoint uploads, and its diffs open on the Hub with the machine offline",
    () =>
      Effect.gen(function* () {
        const loaded = yield* loadFixture("simple");
        const hub = yield* makeHub();
        const laptop = yield* hub.join({
          name: "Laptop",
          adapters: withEditingTurns(loaded.adapters, {
            file: "notes.md",
            content: "Written on the Laptop",
          }),
        });
        yield* replayOn(hub, laptop, loaded);
        const [threadId] = loaded.materialized.projectionThreadIds;
        assert.isDefined(threadId);
        yield* awaitUploaded(hub, threadId, 1);
        yield* laptop.disconnect;

        const diffs = hub.service(CheckpointDiffQuery.CheckpointDiffQuery);
        const turn = yield* diffs.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
        assert.include(turn.diff, "+Written on the Laptop (turn 1)");
        const whole = yield* diffs.getFullThreadDiff({ threadId, toTurnCount: 1 });
        assert.include(whole.diff, "notes.md");

        // Uploaded to the Hub, not to the Project's own remote the Laptop cloned from.
        const projection = yield* hub
          .service(Orchestrator.OrchestratorV2)
          .getThreadProjection(threadId);
        const project = yield* hub
          .service(ProjectStore.ProjectStoreV2)
          .get(projection.thread.projectId);
        assert.isTrue(Option.isSome(project));
        const origin = Option.getOrThrow(project).workspaceRoot;
        assert.equal((yield* git(origin, ["for-each-ref", "refs/t3/"])).stdout, "");
        for (const checkpoint of projection.checkpoints) {
          if (checkpoint.status === "ready") assert.isTrue(checkpoint.uploadedToHub, checkpoint.id);
        }
      }).pipe(Effect.scoped),
  );

  it.live("a machine reads and writes only the refs of Threads it runs, and deletes none", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const desktop = yield* hub.join({ name: "Desktop", adapters: idleAdapters(instanceId) });
      const projectId = ProjectId.make("project:shared");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Shared",
        defaultModelSelection: null,
      });
      const threadId = ThreadId.make("thread:on-laptop");
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:thread-on-laptop"),
        threadId,
        projectId,
        title: "On the Laptop",
        modelSelection: { instanceId, model: "claude-sonnet-4-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeEnvironmentId: laptop.environmentId,
      });
      const scopeId = CheckpointScopeId.make("scope:on-laptop");
      const projection = yield* hub
        .service(Orchestrator.OrchestratorV2)
        .getThreadProjection(threadId);
      yield* hub.server.eventSink.write({
        events: [
          {
            id: EventId.make("event:on-laptop-scope"),
            type: "checkpoint-scope.created",
            threadId,
            occurredAt: projection.thread.createdAt,
            payload: {
              id: scopeId,
              threadId,
              runId: null,
              nodeId: NodeId.make("node:on-laptop"),
              parentScopeId: null,
              providerThreadId: null,
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: workspaceRoot,
              createdAt: projection.thread.createdAt,
            },
          },
        ],
      });
      const checkpointRef = yield* checkpointRefForScopeOrdinal({
        scopeId,
        ordinalWithinScope: 1,
      }).pipe(Effect.provide(NodeCrypto.layer));
      const headRef = `${HubRepository.threadRefPrefixes(threadId)[0]}head`;
      // A checkpoint is a commit of its own, never a tip of the Project's branches (which every
      // machine working in the Project reads).
      const checkpointCommit = (yield* git(workspaceRoot, [
        "-c",
        "user.email=hub@example.com",
        "-c",
        "user.name=Hub",
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        "HEAD",
        "-m",
        "Checkpoint",
      ])).stdout.trim();
      yield* git(workspaceRoot, ["update-ref", checkpointRef, checkpointCommit]);
      yield* git(workspaceRoot, ["update-ref", headRef, checkpointCommit]);
      const on = (machine: TestEnvironment, ...args: ReadonlyArray<string>) => {
        const remote = HubRepository.withEnvironmentCredential(
          HubRepository.hubRepositoryUrl(hub.server.url, { projectId }),
          machine.credential,
        );
        return git(workspaceRoot, [args[0]!, remote.url, ...args.slice(1)], {
          env: remote.env ?? {},
        });
      };

      // The Laptop runs the Thread: it uploads the Thread's refs.
      const succeeded = (output: { readonly exitCode: number; readonly stderr: string }) =>
        assert.equal(output.exitCode, 0, output.stderr);
      succeeded(yield* on(laptop, "push", `+${checkpointRef}:${checkpointRef}`));
      succeeded(yield* on(laptop, "push", `+${headRef}:${headRef}`));
      assert.include((yield* on(laptop, "ls-remote")).stdout, checkpointRef);
      // Another machine sees none of them and changes none, nor writes outside a Thread's refs.
      const seen = (yield* on(desktop, "ls-remote")).stdout;
      assert.notInclude(seen, checkpointRef);
      assert.notInclude(seen, headRef);
      // Nor fetches a hidden object by its id, in any protocol version.
      const sha = (yield* git(workspaceRoot, ["rev-parse", checkpointRef])).stdout.trim();
      const fresh = `${workspaceRoot}-fresh`;
      yield* git(workspaceRoot, ["init", "-q", fresh]);
      for (const version of ["2", "0"]) {
        const remote = HubRepository.withEnvironmentCredential(
          HubRepository.hubRepositoryUrl(hub.server.url, { projectId }),
          desktop.credential,
        );
        const stolen = yield* git(
          fresh,
          ["-c", `protocol.version=${version}`, "fetch", "-q", remote.url, sha],
          { env: remote.env ?? {} },
        );
        assert.notEqual(stolen.exitCode, 0, `protocol ${version}`);
      }
      assert.notEqual((yield* on(desktop, "push", `+HEAD:${checkpointRef}`)).exitCode, 0);
      assert.notEqual((yield* on(desktop, "push", `+HEAD:${headRef}`)).exitCode, 0);
      assert.notEqual((yield* on(laptop, "push", "+HEAD:refs/heads/main")).exitCode, 0);
      // Nobody deletes on the Hub, the machine that runs the Thread included.
      assert.notEqual((yield* on(laptop, "push", `:${checkpointRef}`)).exitCode, 0);
      assert.include((yield* on(laptop, "ls-remote")).stdout, checkpointRef);
    }).pipe(Effect.scoped),
  );

  it.live("a failed upload shows as not uploaded and retries when the machine comes back", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      const { threadId } = opened;
      const [{ ref, checkpointId }] = yield* seedCheckpoints(hub, threadId, 1);
      yield* hub.service(CheckpointUploadService.CheckpointUploads).request(threadId);

      const pushed = yield* opened.machine.nextFrame;
      assert.equal(pushed.method, "checkpoint.push");
      assert.deepEqual(pushed.payload, {
        cwd: "/remote/projects/protocol",
        projectId: "project:protocol",
        checkpointRefs: [ref],
      });
      yield* opened.machine.connection.receive({
        type: "response",
        requestId: pushed.requestId,
        result: {
          _tag: "failure",
          error: {
            _tag: "VcsProcessExitError",
            operation: "HubRepository.push",
            command: "git push",
            cwd: "/remote/projects/protocol",
            exitCode: 128,
            detail: "Could not reach the Hub.",
          },
        },
      });
      const stored = yield* hub.server.sql<{ readonly uploaded: number | null }>`
        SELECT uploaded_to_hub AS uploaded FROM orchestration_v2_projection_checkpoints
        WHERE checkpoint_id = ${checkpointId}
      `;
      assert.deepEqual(stored, [{ uploaded: 0 }]);

      // The machine reconnects: the upload runs again at once, and the turn is marked uploaded.
      yield* opened.machine.disconnect;
      const back = yield* connectProtocolEnvironment(hub, {
        environmentId: opened.environmentId,
        instanceId: opened.instanceId,
        driver: CLAUDE,
        capabilities: ClaudeProviderCapabilitiesV2,
      });
      const retried = yield* back.nextFrame;
      assert.equal(retried.method, "checkpoint.push");
      yield* back.connection.receive({
        type: "response",
        requestId: retried.requestId,
        result: { _tag: "success", value: null },
      });
      yield* awaitUploaded(hub, threadId, 1);
    }).pipe(Effect.scoped),
  );

  it.live("a ref its machine lacks is left for its source machine and holds back no other", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      const [first, second] = yield* seedCheckpoints(hub, opened.threadId, 2);
      assert.isDefined(second);
      const transfer = (refs: ReadonlyArray<CheckpointRef>) => ({
        cwd: "/remote/projects/protocol",
        projectId: "project:protocol",
        checkpointRefs: refs,
      });
      yield* hub.service(CheckpointUploadService.CheckpointUploads).request(opened.threadId);

      // The batch fails, so each ref goes on its own: the one this checkout lacks is set aside.
      yield* answerNext(
        opened.machine,
        "checkpoint.push",
        transfer([first.ref, second.ref]),
        PUSH_FAILED,
      );
      yield* answerNext(opened.machine, "checkpoint.push", transfer([first.ref]), {
        _tag: "success",
        value: null,
      });
      yield* answerNext(opened.machine, "checkpoint.push", transfer([second.ref]), PUSH_FAILED);
      yield* answerNext(
        opened.machine,
        "checkpoint.hasRef",
        { cwd: "/remote/projects/protocol", checkpointRef: second.ref },
        { _tag: "success", value: false },
      );
      yield* awaitUploaded(hub, opened.threadId, 1);
      const stored = yield* hub.server.sql<{ readonly id: string; readonly uploaded: number }>`
        SELECT checkpoint_id AS id, uploaded_to_hub AS uploaded
        FROM orchestration_v2_projection_checkpoints ORDER BY ordinal_within_scope
      `;
      assert.deepEqual(stored, [
        { id: first.checkpointId, uploaded: 1 },
        { id: second.checkpointId, uploaded: 0 },
      ]);
    }).pipe(Effect.scoped),
  );
});
