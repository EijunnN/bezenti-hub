/**
 * A Thread's secret values as `[NAME]` in everything the Hub keeps or shows (spec 5 «Vaults»,
 * ticket 05): the agent prints a secret and writes it to a file; the stored events, the projection,
 * the diff, a file read, the terminal a client watches and every file of the Hub's state show
 * `[OWNER_TOKEN]`, never the value. A value rotated since stays masked.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the tests read the Hub's files on disk.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentAuthenticatedPrincipal,
  type EnvironmentSessionPrincipalShape,
  MAIN_VAULT_ID,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UserId,
  type VaultEntryId,
} from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { forgetKnownSecretsForTest, maskDeep } from "@t3tools/shared/secretMasking";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SecretMasker from "../vaults/SecretMasker.ts";
import * as Vaults from "../vaults/Vaults.ts";
import { type Hub, makeHub, seedProject } from "./HubWithEnvironments.testkit.ts";
import {
  awaitUploaded,
  createOrganization,
  loadFixture,
  ownerIdOf,
  replayOn,
  withEditingTurns,
} from "./HubWithEnvironments.scenarios.testkit.ts";

const OWNER_TOKEN = "owner-token-value-3333";
const ROTATED_TOKEN = "owner-token-rotated-4444";

/** The Hub's workspace RPCs (what `ws.ts` calls), over the Hub's own projection and Environments. */
const threadWorkspaceOf = (hub: Hub) =>
  ThreadWorkspace.make.pipe(
    Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
    Effect.provideContext(hub.server.services as never),
  ) as Effect.Effect<ThreadWorkspace.ThreadWorkspace["Service"]>;

/**
 * An agent that takes its secrets and prints one: its reply carries the value it received, split
 * in two as a streamed reply would. (The recorded reply is «fixture simple ok».)
 */
const printingSecret = (
  adapters: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >,
  value: string,
) =>
  Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.map(ProviderAdapterRegistry.ProviderAdapterRegistryV2, (registry) => ({
      ...registry,
      get: (instanceId: ProviderInstanceId) =>
        registry.get(instanceId).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            receivesSecretEnv: true as const,
            openSession: (open: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              adapter.openSession(open).pipe(
                Effect.map((runtime) => ({
                  ...runtime,
                  events: runtime.events.pipe(
                    Stream.map((event) =>
                      maskDeep(event, (text) =>
                        text.replaceAll("fixture simple ok", `the token is ${value}, ok`),
                      ),
                    ),
                  ),
                })),
              ),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

/** Every file of the Hub's state outside the sealed store that holds `value`, by path. */
const hubFilesHolding = (hub: Hub, value: string) =>
  Effect.promise(async () => {
    const { stateDir } = hub.service(ServerConfig.ServerConfig);
    const needle = Buffer.from(value);
    const found: Array<string> = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        const full = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (full !== NodePath.join(stateDir, "secrets")) await walk(full);
        } else if (entry.isFile() && NodeFS.readFileSync(full).includes(needle)) {
          found.push(NodePath.relative(stateDir, full));
        }
      }
    };
    await walk(stateDir);
    return found;
  });

/** Every row of every table of the Hub's database, as text. */
const databaseText = (hub: Hub) =>
  Effect.gen(function* () {
    const tables = yield* hub.server.sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `;
    let text = "";
    for (const { name } of tables) {
      const rows = yield* hub.server.sql.unsafe(`SELECT * FROM "${name}"`);
      text += JSON.stringify(rows);
    }
    return text;
  });

const putOwnerToken = (hub: Hub, owner: UserId, value: string, entryId?: VaultEntryId) =>
  hub
    .service(Vaults.Vaults)
    .putEntry({
      vaultId: MAIN_VAULT_ID,
      ...(entryId === undefined ? {} : { entryId }),
      name: "OWNER_TOKEN",
      value: Redacted.make(value),
    })
    .pipe(CommandActor.actAs(owner));

/** The Hub's copy of the Thread's Project: the folder clients name. */
const hubCheckoutOf = Effect.fn(function* (hub: Hub, threadId: ThreadId) {
  const projection = yield* hub.service(Orchestrator.OrchestratorV2).getThreadProjection(threadId);
  const project = yield* hub.service(ProjectStore.ProjectStoreV2).get(projection.thread.projectId);
  return projection.thread.worktreePath ?? Option.getOrThrow(project).workspaceRoot;
});

/** The Owner's Thread on the Laptop: its agent printed OWNER_TOKEN and wrote it to notes.md. */
const turnThatPrintsTheSecret = Effect.fn(function* () {
  const loaded = yield* loadFixture("simple");
  const hub = yield* makeHub();
  const owner = yield* ownerIdOf(hub);
  const { entry } = yield* putOwnerToken(hub, owner, OWNER_TOKEN);
  const laptop = yield* hub.join({
    name: "Laptop",
    adapters: printingSecret(
      withEditingTurns(loaded.adapters, { file: "notes.md", content: `TOKEN=${OWNER_TOKEN}` }),
      OWNER_TOKEN,
    ),
  });
  yield* replayOn(hub, laptop, loaded, { ownerUserId: owner });
  const [threadId] = loaded.materialized.projectionThreadIds;
  assert.isDefined(threadId);
  yield* awaitUploaded(hub, threadId, 1);
  return { hub, laptop, owner, threadId: threadId as ThreadId, entryId: entry.id };
});

describe("Hub con Environments: a Thread's secret values are masked in its history", () => {
  it.live("stored events, projection, diff and file reads show [OWNER_TOKEN]", () =>
    Effect.gen(function* () {
      const { hub, owner, threadId } = yield* turnThatPrintsTheSecret();

      // The reply as the projection (WS, HttpApi, guest and MCP doors read it) keeps it.
      const projection = yield* hub
        .service(Orchestrator.OrchestratorV2)
        .getThreadProjection(threadId);
      const reply = JSON.stringify(projection);
      assert.include(reply, "the token is [OWNER_TOKEN], ok");
      assert.notInclude(reply, OWNER_TOKEN);

      // Nowhere in the database: events, projections, outbox, receipts.
      const database = yield* databaseText(hub);
      assert.include(database, "[OWNER_TOKEN]");
      assert.notInclude(database, OWNER_TOKEN);

      // The checkpoint's diff of the file the agent wrote.
      const diffs = hub.service(CheckpointDiffQuery.CheckpointDiffQuery);
      const turn = yield* diffs.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
      assert.include(turn.diff, "+TOKEN=[OWNER_TOKEN] (turn 1)");
      assert.notInclude(turn.diff, OWNER_TOKEN);
      const whole = yield* diffs.getFullThreadDiff({ threadId, toTurnCount: 1 });
      assert.notInclude(whole.diff, OWNER_TOKEN);

      // The file as a client reads it from the Laptop (the Laptop's own copy keeps the value).
      const workspace = yield* threadWorkspaceOf(hub);
      const cwd = yield* hubCheckoutOf(hub, threadId);
      const read = yield* workspace.readFile(
        { cwd, relativePath: "notes.md", threadId },
        { userId: owner },
      );
      assert.equal(read.contents, "TOKEN=[OWNER_TOKEN] (turn 1)\n");
      const search = yield* workspace.searchContents(
        {
          cwd,
          query: "owner-token",
          limit: 10,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
          threadId,
        },
        { userId: owner },
      );
      assert.isEmpty(search.matches, "a search never spells the value out");

      // No file of the Hub's state outside its sealed store holds it.
      assert.deepEqual(yield* hubFilesHolding(hub, OWNER_TOKEN), []);
    }).pipe(Effect.scoped),
  );

  it.live("terminal output reaches the client masked, a value split between frames too", () =>
    Effect.gen(function* () {
      const { hub, owner, threadId } = yield* turnThatPrintsTheSecret();
      const workspace = yield* threadWorkspaceOf(hub);
      const caller = { userId: owner };
      const cwd = yield* hubCheckoutOf(hub, threadId);
      yield* workspace.terminalOpen(
        { threadId, terminalId: "term-1", cwd, cols: 80, rows: 24 },
        caller,
      );
      const attached = yield* Deferred.make<void>();
      const frames = yield* Queue.unbounded<string>();
      yield* workspace.terminalAttach({ threadId, terminalId: "term-1" }, "viewer-1", caller).pipe(
        Stream.runForEach((event) =>
          event.type === "snapshot"
            ? Deferred.succeed(attached, undefined)
            : event.type === "output"
              ? Queue.offer(frames, event.data)
              : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(attached);
      yield* workspace.terminalWrite(
        { threadId, terminalId: "term-1", data: "echo $OWNER_TOKEN\r" },
        caller,
      );
      assert.equal(yield* Queue.take(frames), "[OWNER_TOKEN]\r\n");
      // Printed in two writes of the PTY, cut in the middle of the value: one masked frame.
      yield* workspace.terminalWrite(
        { threadId, terminalId: "term-1", data: "split $OWNER_TOKEN\r" },
        caller,
      );
      assert.equal(yield* Queue.take(frames), "out: [OWNER_TOKEN]\r\n");

      // A snapshot (what a client gets on attach) holds the history masked.
      const reopened = yield* workspace.terminalOpen(
        { threadId, terminalId: "term-1", cwd, cols: 80, rows: 24 },
        caller,
      );
      assert.include(reopened.history, "[OWNER_TOKEN]");
      assert.notInclude(reopened.history, OWNER_TOKEN);
    }).pipe(Effect.scoped),
  );

  it.live("a value rotated since is still masked for the Thread's life", () =>
    Effect.gen(function* () {
      const { hub, owner, threadId, entryId } = yield* turnThatPrintsTheSecret();
      // The Owner rotates the secret; the Laptop's file still holds the value the agent wrote.
      yield* putOwnerToken(hub, owner, ROTATED_TOKEN, entryId);
      const cwd = yield* hubCheckoutOf(hub, threadId);
      const workspace = yield* threadWorkspaceOf(hub);
      const read = yield* workspace.readFile(
        { cwd, relativePath: "notes.md", threadId },
        { userId: owner },
      );
      assert.equal(read.contents, "TOKEN=[OWNER_TOKEN] (turn 1)\n");

      // After a restart (a masker that starts empty, a process that knows no value) too: the old
      // value stays sealed while the Thread lives, and the Thread remembers it received it.
      forgetKnownSecretsForTest();
      const restarted = yield* SecretMasker.make.pipe(
        Effect.provideContext(hub.server.services as never),
      ) as Effect.Effect<SecretMasker.SecretMasker["Service"]>;
      const masker = yield* restarted.forThread(threadId);
      assert.equal(masker.mask(`was ${OWNER_TOKEN}`), "was [OWNER_TOKEN]");
      assert.equal(masker.mask(`now ${ROTATED_TOKEN}`), "now [OWNER_TOKEN]");
    }).pipe(Effect.scoped),
  );

  it.live("a new Thread's first message and title are masked before any process ran", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const owner = yield* ownerIdOf(hub);
      yield* putOwnerToken(hub, owner, OWNER_TOKEN);
      const projectId = ProjectId.make("project:pasted");
      yield* seedProject(hub.server, { projectId, title: "Pasted", defaultModelSelection: null });
      const threadId = ThreadId.make("thread:pasted");
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:pasted"),
        threadId,
        projectId,
        title: `My token is ${OWNER_TOKEN}`,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        ownerUserId: owner,
      });
      const projection = yield* hub
        .service(Orchestrator.OrchestratorV2)
        .getThreadProjection(threadId);
      assert.equal(projection.thread.title, "My token is [OWNER_TOKEN]");
      assert.notInclude(yield* databaseText(hub), OWNER_TOKEN);
    }).pipe(Effect.scoped),
  );
  it.live("an editor save over a file that shows a secret is refused; the file keeps it", () =>
    Effect.gen(function* () {
      const { hub, laptop, owner, threadId } = yield* turnThatPrintsTheSecret();
      const workspace = yield* threadWorkspaceOf(hub);
      const cwd = yield* hubCheckoutOf(hub, threadId);
      const caller = { userId: owner };
      const shown = yield* workspace.readFile({ cwd, relativePath: "notes.md", threadId }, caller);
      assert.equal(shown.contents, "TOKEN=[OWNER_TOKEN] (turn 1)\n");
      assert.isTrue(shown.masked, "the editor opens it read-only");
      // The editor saves what it was shown, with a line added: refused.
      const saved = yield* Effect.exit(
        workspace.writeFile(
          { cwd, relativePath: "notes.md", contents: `${shown.contents}reviewed\n`, threadId },
          caller,
        ),
      );
      assert.isTrue(Exit.isFailure(saved));
      assert.include(
        String(Cause.squash((saved as Exit.Failure<never, unknown>).cause)),
        "secrets",
      );
      const projection = yield* hub
        .service(Orchestrator.OrchestratorV2)
        .getThreadProjection(threadId);
      const laptopCheckout = Option.getOrThrow(
        yield* (yield* hub
          .service(EnvironmentExecutor.EnvironmentExecutorRegistry)
          .get(laptop.environmentId)).workspace.paths.checkout(projection.thread.projectId),
      );
      const onDisk = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(laptopCheckout, "notes.md"), "utf8"),
      );
      assert.equal(onDisk, `TOKEN=${OWNER_TOKEN} (turn 1)\n`);
      // A file without one saves as before.
      yield* workspace.writeFile(
        { cwd, relativePath: "plain.md", contents: "nothing secret\n", threadId },
        caller,
      );
      const plain = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(laptopCheckout, "plain.md"), "utf8"),
      );
      assert.equal(plain, "nothing secret\n");
    }).pipe(Effect.scoped),
  );

  it.live("never masks a Thread with another User's values", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const owner = yield* ownerIdOf(hub);
      yield* putOwnerToken(hub, owner, OWNER_TOKEN);
      const acme = yield* createOrganization(hub, "Acme");
      yield* addMember(hub.server, { id: "ada", displayName: "ada" });
      yield* joinOrganization(hub.server, acme, "ada", "member");
      const ada = UserId.make("ada");
      yield* hub.service(SpaceDirectory.SpaceDirectory).membershipsChanged([ada]);
      const projectId = ProjectId.make("project:acme-guess");
      yield* seedProject(hub.server, {
        projectId,
        title: "Acme",
        defaultModelSelection: null,
        spaceId: acme,
      });
      // Ada types the Owner's value (a guess) into her own Thread: it stays as she typed it, so
      // masking never confirms another User's secret or its name.
      const threadId = ThreadId.make("thread:ada-guess");
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:ada-guess"),
        threadId,
        projectId,
        title: `Is it ${OWNER_TOKEN}?`,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        spaceId: acme,
        ownerUserId: ada,
      });
      const projection = yield* hub
        .service(Orchestrator.OrchestratorV2)
        .getThreadProjection(threadId);
      assert.equal(projection.thread.title, `Is it ${OWNER_TOKEN}?`);
    }).pipe(Effect.scoped),
  );

  it.live("what a User reads is masked with their own values only, as the request's User", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const owner = yield* ownerIdOf(hub);
      const acme = yield* createOrganization(hub, "Acme");
      yield* addMember(hub.server, { id: "ada", displayName: "ada" });
      yield* joinOrganization(hub.server, acme, "ada", "member");
      const ada = UserId.make("ada");
      yield* hub.service(SpaceDirectory.SpaceDirectory).membershipsChanged([ada]);
      const projectId = ProjectId.make("project:acme-shared");
      yield* seedProject(hub.server, {
        projectId,
        title: "Acme",
        defaultModelSelection: null,
        spaceId: acme,
      });
      const orchestrator = hub.service(Orchestrator.OrchestratorV2);
      const create = (threadId: ThreadId, ownerUserId: UserId) =>
        orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${threadId}`),
          threadId,
          projectId,
          title: "Shared checkout",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          spaceId: acme,
          ownerUserId,
        });
      const ownerThread = ThreadId.make("thread:owner-shared");
      const adaThread = ThreadId.make("thread:ada-shared");
      yield* create(ownerThread, owner);
      yield* create(adaThread, ada);
      const masker = hub.service(SecretMasker.SecretMasker);
      const OWNER_VALUE = "owner-shared-value-5151";
      const ADA_VALUE = "ada-shared-value-6262";
      yield* masker.remember(ownerThread, [
        { name: "OWNER_SECRET", value: OWNER_VALUE, valueId: "value-owner-shared" },
      ]);
      yield* masker.remember(adaThread, [
        { name: "ADA_SECRET", value: ADA_VALUE, valueId: "value-ada-shared" },
      ]);
      const text = `${OWNER_VALUE} ${ADA_VALUE}`;
      // What a User reads (files, search, diffs, change requests, Git output) is masked with their
      // own values: Ada's never confirm the Owner's, whatever Thread or folder a client names.
      assert.equal((yield* masker.forUser(ada)).mask(text), `${OWNER_VALUE} [ADA_SECRET]`);
      assert.equal((yield* masker.forUser(owner)).mask(text), `[OWNER_SECRET] ${ADA_VALUE}`);
      // The same for a checkout's diffs, change requests and Git output (the request's User).
      const as = (userId: UserId) =>
        Effect.provideService(EnvironmentAuthenticatedPrincipal, {
          userId,
        } as unknown as EnvironmentSessionPrincipalShape);
      const viewed = masker.forViewer.pipe(Effect.map((found) => found.mask(text)));
      assert.equal(yield* viewed.pipe(as(ada)), `${OWNER_VALUE} [ADA_SECRET]`);
      assert.equal(yield* viewed.pipe(as(owner)), `[OWNER_SECRET] ${ADA_VALUE}`);
      // No User asks (an internal call): no one's values, so no one's guess is confirmed.
      assert.equal(yield* viewed, text);
    }).pipe(Effect.scoped),
  );
});
