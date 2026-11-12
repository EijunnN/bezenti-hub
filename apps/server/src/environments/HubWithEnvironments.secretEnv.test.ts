/**
 * A Thread's secrets as environment variables (spec 5 «Vaults», ticket 04): a provider session, a
 * terminal and a setup script get the secrets of the User who starts them, on the Thread's machine
 * alone, and a machine on an executor contract before 10 gets none and says why.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the tests make checkouts on disk.
import * as NodeFSP from "node:fs/promises";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type EnvironmentId,
  MAIN_VAULT_ID,
  ProjectId,
  type ProviderInstanceId,
  type SecretEnv,
  type SpaceId,
  ThreadId,
  UserId,
  sandboxEnvironmentIdOf,
} from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import * as SecretDelivery from "../vaults/SecretDelivery.ts";
import * as Vaults from "../vaults/Vaults.ts";
import {
  type Hub,
  makeHub,
  seedProject,
  type TestEnvironment,
} from "./HubWithEnvironments.testkit.ts";
import {
  createOrganization,
  idleAdapters,
  loadFixture,
  ownerIdOf,
  replayOn,
  startSandbox,
} from "./HubWithEnvironments.scenarios.testkit.ts";

const ACME_TOKEN = "acme-token-value-1111";
const GRACE_TOKEN = "grace-token-value-2222";
const OWNER_TOKEN = "owner-token-value-3333";

/** The Hub's workspace RPCs (what `ws.ts` calls), over the Hub's own projection and Environments. */
const threadWorkspaceOf = (hub: Hub) =>
  ThreadWorkspace.make.pipe(
    Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
    Effect.provideContext(hub.server.services as never),
  ) as Effect.Effect<ThreadWorkspace.ThreadWorkspace["Service"]>;

/** Makes the Project's checkout on the machine, as its first turn would. */
const checkoutOnMachine = Effect.fn(function* (
  hub: Hub,
  environmentId: EnvironmentId,
  projectId: ProjectId,
) {
  const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const checkout = Option.getOrThrow(
    yield* (yield* registry.get(environmentId)).workspace.paths.checkout(projectId),
  );
  yield* Effect.promise(() => NodeFSP.mkdir(checkout, { recursive: true }));
});

/** A machine's adapters that note the secrets each session opened with and take them. */
const recordingSecrets = (
  adapters: Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    never,
    McpProviderSessions.McpProviderSessions
  >,
  seen: Array<SecretEnv | undefined>,
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
            openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
              Effect.suspend(() => {
                seen.push(input.secretEnv);
                return adapter.openSession(input);
              }),
          })),
        ),
    })),
  ).pipe(Layer.provide(adapters));

const valueOf = (secretEnv: SecretEnv | undefined, name: string) =>
  secretEnv?.variables?.find((variable) => variable.name === name)?.value;

/** Ada and Grace (Members of Acme) share Acme's Sandbox; Grace has a Vault of her own. */
const sharedSandbox = Effect.fn(function* () {
  const instanceId = "claudeAgent" as ProviderInstanceId;
  const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
  const owner = yield* ownerIdOf(hub);
  const acme = yield* createOrganization(hub, "Acme");
  const globex = yield* createOrganization(hub, "Globex");
  for (const id of ["ada", "grace"]) {
    yield* addMember(hub.server, { id, displayName: id });
    yield* joinOrganization(hub.server, acme, id, "member");
  }
  const ada = UserId.make("ada");
  const grace = UserId.make("grace");
  yield* hub.service(SpaceDirectory.SpaceDirectory).membershipsChanged([ada, grace]);

  const vaults = hub.service(Vaults.Vaults);
  const asOwner = CommandActor.actAs(owner);
  const acmeVault = yield* vaults.create({ name: "Acme", spaceId: acme }).pipe(asOwner);
  yield* vaults
    .putEntry({ vaultId: acmeVault.id, name: "ACME_TOKEN", value: Redacted.make(ACME_TOKEN) })
    .pipe(asOwner);
  yield* vaults.setSpaceDefaults({ spaceId: acme, vaultIds: [acmeVault.id] }).pipe(asOwner);
  const graceVault = yield* vaults.create({ name: "Grace keys", spaceId: null }).pipe(asOwner);
  yield* vaults
    .putEntry({ vaultId: graceVault.id, name: "GRACE_TOKEN", value: Redacted.make(GRACE_TOKEN) })
    .pipe(asOwner);
  yield* vaults
    .allow({ vaultId: graceVault.id, subject: { kind: "user", userId: grace }, allowed: true })
    .pipe(asOwner);

  const project = Effect.fn(function* (id: string, spaceId: SpaceId) {
    const projectId = ProjectId.make(id);
    const { workspaceRoot } = yield* seedProject(hub.server, {
      projectId,
      title: id,
      defaultModelSelection: null,
      spaceId,
    });
    return { projectId, workspaceRoot };
  });
  const thread = Effect.fn(function* (
    id: string,
    projectId: ProjectId,
    spaceId: SpaceId,
    ownerUserId: UserId,
  ) {
    const threadId = ThreadId.make(id);
    yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${id}`),
      threadId,
      projectId,
      title: id,
      modelSelection: { instanceId, model: "claude-sonnet-4-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      spaceId,
      ownerUserId,
      activeEnvironmentId: sandboxEnvironmentIdOf(spaceId),
    });
    return threadId;
  });
  const acmeWeb = yield* project("project:acme-web", acme);
  const adaThread = yield* thread("thread:ada", acmeWeb.projectId, acme, ada);
  const graceThread = yield* thread("thread:grace", acmeWeb.projectId, acme, grace);
  yield* startSandbox(hub, acme);
  yield* checkoutOnMachine(hub, sandboxEnvironmentIdOf(acme), acmeWeb.projectId);
  return {
    hub,
    owner,
    acme,
    globex,
    ada,
    grace,
    acmeWeb,
    adaThread,
    graceThread,
    graceVault: graceVault.id,
    acmeVault: acmeVault.id,
    project,
    thread,
    vaults,
    asOwner,
    sandbox: yield* hub.sandboxOf(acme),
    workspace: yield* threadWorkspaceOf(hub),
  };
});

/** The environment of the shell the machine started last. */
const lastShell = (machine: TestEnvironment) => {
  const spawn = machine.ptySpawns.at(-1);
  assert.isDefined(spawn);
  return spawn.env;
};

describe("Hub con Environments: a Thread's secrets as environment variables", () => {
  it.live("reach each User's terminals alone, in a Sandbox two Users share", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      const cwd = s.acmeWeb.workspaceRoot;

      yield* s.workspace.terminalOpen(
        { threadId: s.adaThread, terminalId: "term-1", cwd },
        { userId: s.ada },
      );
      const adas = lastShell(s.sandbox);
      assert.equal(adas.ACME_TOKEN, ACME_TOKEN);
      assert.isUndefined(adas.GRACE_TOKEN, "Grace's own Vault never reaches Ada's shell");

      yield* s.workspace.terminalOpen(
        { threadId: s.graceThread, terminalId: "term-1", cwd },
        { userId: s.grace },
      );
      const graces = lastShell(s.sandbox);
      assert.equal(graces.ACME_TOKEN, ACME_TOKEN);
      assert.equal(graces.GRACE_TOKEN, GRACE_TOKEN);

      // Ada's shell, started before, never got Grace's value either.
      assert.isTrue(
        s.sandbox.ptySpawns.every(
          (spawn) => spawn.env.GRACE_TOKEN === undefined || spawn === s.sandbox.ptySpawns.at(-1),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("stop reaching the next shell once revoked; an open one says to reopen", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      const cwd = s.acmeWeb.workspaceRoot;
      const open = (terminalId: string) =>
        s.workspace.terminalOpen({ threadId: s.graceThread, terminalId, cwd }, { userId: s.grace });
      yield* open("term-1");
      assert.equal(lastShell(s.sandbox).GRACE_TOKEN, GRACE_TOKEN);
      yield* s.vaults
        .allow({
          vaultId: s.graceVault,
          subject: { kind: "user", userId: s.grace },
          allowed: false,
        })
        .pipe(s.asOwner);

      const spawnsBefore = s.sandbox.ptySpawns.length;
      yield* open("term-2");
      assert.equal(s.sandbox.ptySpawns.length, spawnsBefore + 1);
      const next = lastShell(s.sandbox);
      assert.isUndefined(next.GRACE_TOKEN, "a revoked Vault reaches no new shell");
      assert.equal(next.ACME_TOKEN, ACME_TOKEN);

      // The running shell keeps what it started with (the accepted limit) and says so.
      const reopened = yield* open("term-1");
      assert.equal(s.sandbox.ptySpawns.length, spawnsBefore + 1, "no new shell for term-1");
      assert.isTrue(reopened.secretsStale);
    }).pipe(Effect.scoped),
  );

  it.live("never reach another Space's Sandbox", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      const globexApp = yield* s.project("project:globex-app", s.globex);
      const threadId = yield* s.thread("thread:globex", globexApp.projectId, s.globex, s.owner);
      yield* startSandbox(s.hub, s.globex);
      yield* checkoutOnMachine(s.hub, sandboxEnvironmentIdOf(s.globex), globexApp.projectId);
      const globexSandbox = yield* s.hub.sandboxOf(s.globex);
      yield* s.workspace.terminalOpen(
        { threadId, terminalId: "term-1", cwd: globexApp.workspaceRoot },
        { userId: s.owner },
      );
      const env = lastShell(globexSandbox);
      assert.isUndefined(env.ACME_TOKEN);
      assert.isUndefined(env.GRACE_TOKEN);
      assert.isEmpty(s.sandbox.ptySpawns, "Acme's Sandbox started no shell for it");
    }).pipe(Effect.scoped),
  );

  it.live("reach the provider session of a turn, as its Thread owner's", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const hub = yield* makeHub();
      const owner = yield* ownerIdOf(hub);
      yield* hub
        .service(Vaults.Vaults)
        .putEntry({
          vaultId: MAIN_VAULT_ID,
          name: "OWNER_TOKEN",
          value: Redacted.make(OWNER_TOKEN),
        })
        .pipe(CommandActor.actAs(owner));
      const seen: Array<SecretEnv | undefined> = [];
      const laptop = yield* hub.join({
        name: "Laptop",
        adapters: recordingSecrets(loaded.adapters, seen),
      });
      yield* replayOn(hub, laptop, loaded, { ownerUserId: owner });
      assert.isNotEmpty(seen);
      assert.equal(valueOf(seen[0], "OWNER_TOKEN"), OWNER_TOKEN);
    }).pipe(Effect.scoped),
  );

  it.live("never reach a machine before executor contract 10, which says to update", () =>
    Effect.gen(function* () {
      const instanceId = "claudeAgent" as ProviderInstanceId;
      const hub = yield* makeHub();
      const owner = yield* ownerIdOf(hub);
      const old = yield* hub.join({
        name: "Old laptop",
        adapters: idleAdapters(instanceId),
        executorContractVersion: 9,
      });
      const projectId = ProjectId.make("project:old");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Old",
        defaultModelSelection: null,
      });
      const threadId = ThreadId.make("thread:old");
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:old"),
        threadId,
        projectId,
        title: "Old",
        modelSelection: { instanceId, model: "claude-sonnet-4-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        ownerUserId: owner,
        activeEnvironmentId: old.environmentId,
      });
      yield* checkoutOnMachine(hub, old.environmentId, projectId);
      const workspace = yield* threadWorkspaceOf(hub);
      const open = (terminalId: string) =>
        workspace.terminalOpen({ threadId, terminalId, cwd: workspaceRoot }, { userId: owner });

      // Without secrets it works as before.
      yield* open("term-1");
      assert.equal(old.ptySpawns.length, 1);

      yield* hub
        .service(Vaults.Vaults)
        .putEntry({
          vaultId: MAIN_VAULT_ID,
          name: "OWNER_TOKEN",
          value: Redacted.make(OWNER_TOKEN),
        })
        .pipe(CommandActor.actAs(owner));
      const refused = yield* Effect.exit(open("term-2"));
      assert.isTrue(Exit.isFailure(refused));
      if (Exit.isFailure(refused)) {
        assert.include(
          Cause.pretty(refused.cause),
          "Old laptop needs an update to receive this Thread's secrets",
        );
      }
      assert.equal(old.ptySpawns.length, 1, "no shell started without its secrets");
      // An attach that would make a new terminal says the same; the running one still reattaches.
      const attached = yield* Effect.exit(
        workspace
          .terminalAttach({ threadId, terminalId: "term-3", cwd: workspaceRoot }, "viewer-1", {
            userId: owner,
          })
          .pipe(Stream.take(1), Stream.runDrain),
      );
      assert.isTrue(Exit.isFailure(attached));
      if (Exit.isFailure(attached)) {
        assert.include(Cause.pretty(attached.cause), "Old laptop needs an update");
      }
      const reattached = yield* workspace
        .terminalAttach({ threadId, terminalId: "term-1", cwd: workspaceRoot }, "viewer-2", {
          userId: owner,
        })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.equal(reattached.length, 1, "the running shell reattaches, nothing is read");
      assert.equal(old.ptySpawns.length, 1);
      assert.isTrue(
        old.ptySpawns.every((spawn) => spawn.env.OWNER_TOKEN === undefined),
        "the value never reached the old machine",
      );
    }).pipe(Effect.scoped),
  );

  it.live("say a running shell is stale once the User's set became empty", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      const open = () =>
        s.workspace.terminalOpen(
          { threadId: s.graceThread, terminalId: "term-1", cwd: s.acmeWeb.workspaceRoot },
          { userId: s.grace },
        );
      yield* open();
      assert.equal(lastShell(s.sandbox).GRACE_TOKEN, GRACE_TOKEN);
      yield* s.vaults.setSpaceDefaults({ spaceId: s.acme, vaultIds: [] }).pipe(s.asOwner);
      yield* s.vaults
        .allow({
          vaultId: s.graceVault,
          subject: { kind: "user", userId: s.grace },
          allowed: false,
        })
        .pipe(s.asOwner);
      const reopened = yield* open();
      assert.isTrue(reopened.secretsStale, "no secrets now: the shell that has some is stale");
      assert.equal(s.sandbox.ptySpawns.length, 1, "it keeps running");
    }).pipe(Effect.scoped),
  );

  it.live("give a turn its Thread owner's secrets, never those of whoever continues it", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      // A Vault of the Owner's, allowed to the Owner alone.
      const ownersOwn = yield* s.vaults
        .create({ name: "Owner keys", spaceId: null })
        .pipe(s.asOwner);
      yield* s.vaults
        .putEntry({ vaultId: ownersOwn.id, name: "OWNER_ONLY", value: Redacted.make(OWNER_TOKEN) })
        .pipe(s.asOwner);
      yield* s.vaults
        .allow({ vaultId: ownersOwn.id, subject: { kind: "user", userId: s.owner }, allowed: true })
        .pipe(s.asOwner);
      const delivery = s.hub.service(SecretDelivery.SecretDelivery);
      const target = {
        environmentId: sandboxEnvironmentIdOf(s.acme),
        contractVersion: 10,
      };
      const graces = yield* delivery.planTurn({ threadId: s.graceThread, target });
      assert.deepEqual(
        graces.variables.map((v) => v.name),
        ["ACME_TOKEN", "GRACE_TOKEN"],
        "Grace's Thread: her set, whoever sends the turn",
      );
      // Nobody else continues it: the Owner and an Admin are refused at the door.
      const directory = s.hub.service(SpaceDirectory.SpaceDirectory);
      const continued = yield* Effect.exit(
        directory.authorizeItem(s.owner, "thread.continue", { kind: "thread", id: s.graceThread }),
      );
      assert.isTrue(Exit.isFailure(continued), "the Owner does not speak in Grace's Thread");
    }).pipe(Effect.scoped),
  );

  it.live("never attach one User's terminal for another (no door lets them)", () =>
    Effect.gen(function* () {
      const s = yield* sharedSandbox();
      // terminal.attach, open, write and observe are «work» doors: only the Thread's owner passes.
      const visibility = s.hub.service(SpaceVisibility.SpaceVisibility);
      const claim = (userId: UserId) =>
        Effect.flatten(visibility.viewer(userId)).pipe(
          Effect.flatMap((viewer) => visibility.claimWork(viewer, userId, s.graceThread)),
        );
      assert.equal(yield* claim(s.grace), "allowed");
      assert.equal(yield* claim(s.ada), "not-yours");
      assert.equal(yield* claim(s.owner), "not-yours");
    }).pipe(Effect.scoped),
  );

  it.live("refuse, never strip, secrets sent to a machine before contract 10", () =>
    Effect.gen(function* () {
      const instanceId = "claudeAgent" as ProviderInstanceId;
      const hub = yield* makeHub();
      const old = yield* hub.join({
        name: "Old laptop",
        adapters: idleAdapters(instanceId),
        executorContractVersion: 9,
      });
      const projectId = ProjectId.make("project:old-guard");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Old",
        defaultModelSelection: null,
      });
      yield* checkoutOnMachine(hub, old.environmentId, projectId);
      const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
      const forward = Option.getOrThrow((yield* registry.get(old.environmentId)).workspace.forward);
      const checkout = Option.getOrThrow(
        yield* (yield* registry.get(old.environmentId)).workspace.paths.checkout(projectId),
      );
      void workspaceRoot;
      const sent = yield* Effect.exit(
        forward.call("terminal.open", {
          root: checkout,
          input: { threadId: "thread:old-guard", terminalId: "term-1", cwd: checkout },
          secretEnv: {
            fingerprint: "set-1",
            variables: [{ name: "OWNER_TOKEN", value: OWNER_TOKEN }],
          },
        }),
      );
      assert.isTrue(Exit.isFailure(sent));
      if (Exit.isFailure(sent)) assert.include(Cause.pretty(sent.cause), "needs an update");
      assert.isEmpty(old.ptySpawns, "no shell started without its secrets");
      assert.isFalse(old.requests.includes("terminal.open"), "nothing was sent");
    }).pipe(Effect.scoped),
  );
});
