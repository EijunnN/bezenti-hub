// @effect-diagnostics nodeBuiltinImport:off -- the tests read and write files on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import {
  CommandId,
  sandboxEnvironmentIdOf,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as HubRepository from "../checkpointing/HubRepository.ts";
import { addMember, joinOrganization } from "../auth/UserAuth.testkit.ts";
import { listEnvironments } from "./environments.testkit.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PodmanSandboxRuntime from "../sandboxes/PodmanSandboxRuntime.ts";
import {
  ensureDevImage,
  makeTestRun,
  podmanResult,
  removeTestRunContainers,
  rootlessPodmanAvailable,
} from "../sandboxes/PodmanSandboxRuntime.testkit.ts";
import * as ProcessSandboxRuntime from "../sandboxes/ProcessSandboxRuntime.ts";
import * as Sandboxes from "../sandboxes/Sandboxes.ts";
import { devCodeMounts } from "../sandboxes/sandboxRuntimeFromConfig.ts";
import * as SandboxRuntime from "../sandboxes/SandboxRuntime.ts";
import * as OrganizationLifecycle from "../spaces/OrganizationLifecycle.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";
import { makeHub, seedProject } from "./HubWithEnvironments.testkit.ts";
import {
  idleAdapters,
  loadFixture,
  replayOn,
  ownerIdOf,
  git,
  awaitUploaded,
  startSandbox,
  createOrganization,
} from "./HubWithEnvironments.scenarios.testkit.ts";

describe("Hub con Environments: the Sandbox of a Space", () => {
  it.live("is made when first chosen, and a turn runs there with its checkpoints on the Hub", () =>
    Effect.gen(function* () {
      const loaded = yield* loadFixture("simple");
      const hub = yield* makeHub({ sandboxAdapters: loaded.adapters });
      const acme = yield* createOrganization(hub, "Acme");
      const owner = yield* ownerIdOf(hub);
      const sandboxId = sandboxEnvironmentIdOf(acme);
      // Listed before it exists, so it can be chosen.
      const before = yield* listEnvironments(hub.server, hub.owner);
      assert.deepInclude(
        before.map(({ id, name, kind, status }) => ({ id, name, kind, status })),
        { id: sandboxId, name: "Acme Sandbox", kind: "sandbox", status: "stopped" },
      );

      const created = loaded.materialized.commands.find(
        (command) => command.type === "thread.create",
      );
      assert.isDefined(created);
      yield* seedProject(hub.server, {
        projectId: created.projectId,
        title: "Acme web",
        defaultModelSelection: loaded.variant.modelSelection,
        spaceId: acme,
      });
      const placed = yield* hub.service(EnvironmentRegistry.EnvironmentRegistry).chooseForThread({
        userId: owner,
        requested: sandboxId,
        projectId: created.projectId,
        providerInstanceId: loaded.variant.modelSelection.instanceId,
      });
      assert.equal(placed, sandboxId);
      const [row] = yield* hub.server.sql<{
        readonly kind: string;
        readonly spaceId: string;
        readonly ownerUserId: string | null;
        readonly status: string;
      }>`
        SELECT environments.kind, environments.space_id AS "spaceId",
          environments.owner_user_id AS "ownerUserId", sandboxes.status
        FROM environments JOIN sandboxes USING (environment_id)
        WHERE environment_id = ${sandboxId}
      `;
      // Placing makes it and leaves it stopped: its first work starts it.
      assert.deepEqual(row, {
        kind: "sandbox",
        spaceId: acme,
        ownerUserId: null,
        status: "stopped",
      });
      const audited = yield* hub.server.sql<{ readonly action: string; readonly actor: string }>`
        SELECT action, actor_user_id AS actor FROM audit_log WHERE action = 'sandbox.create'
      `;
      assert.deepEqual(audited, [{ action: "sandbox.create", actor: owner }]);

      yield* startSandbox(hub, acme);
      const sandbox = yield* hub.sandboxOf(acme);
      const result = yield* replayOn(hub, sandbox, loaded, { spaceId: acme });
      loaded.variant.assertOutput(result, loaded.transcript);
      const [threadId] = loaded.materialized.projectionThreadIds;
      const projection = result.projections.get(threadId!);
      assert.equal(projection?.thread.activeEnvironmentId, sandboxId);
      // Its checkout is in the Sandbox's own home, the workspace root of its server.
      const home = (yield* listEnvironments(hub.server, hub.owner)).find(
        (environment) => environment.id === sandboxId,
      );
      assert.equal(home?.status, "online");
      assert.isNotEmpty(projection?.checkpointScopes);
      for (const scope of projection?.checkpointScopes ?? []) {
        assert.isTrue(scope.cwd.startsWith(sandbox.workspaceRoot), scope.cwd);
        assert.isTrue(scope.cwd.startsWith(`${hub.sandboxRoot}/sandbox-${acme}/`), scope.cwd);
      }
      yield* awaitUploaded(hub, threadId!, 1);
      // Chosen again, the running Sandbox is the same one: nothing is made twice.
      yield* hub.service(EnvironmentRegistry.EnvironmentRegistry).chooseForThread({
        userId: owner,
        requested: sandboxId,
        projectId: created.projectId,
        providerInstanceId: loaded.variant.modelSelection.instanceId,
      });
      const sandboxes = yield* hub.server.sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sandboxes
      `;
      assert.equal(sandboxes[0]?.count, 1);
    }).pipe(Effect.scoped),
  );

  it.live(
    "is used by those who work in its Space, for its Threads, and its credential reaches no other Space",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
        const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const globex = yield* createOrganization(hub, "Globex");
        const grace = UserId.make("member-1");
        const linus = UserId.make("guest-1");
        const graceCookie = yield* addMember(hub.server, {
          id: grace,
          displayName: "Grace Hopper",
        });
        yield* addMember(hub.server, { id: linus, displayName: "Linus" });
        yield* joinOrganization(hub.server, acme, grace, "member");
        yield* joinOrganization(hub.server, acme, linus, "guest");
        yield* hub.service(SpaceDirectory.SpaceDirectory).changed;
        const acmeProject = ProjectId.make("project:acme");
        const globexProject = ProjectId.make("project:globex");
        const { workspaceRoot: acmeRoot } = yield* seedProject(hub.server, {
          projectId: acmeProject,
          title: "Acme",
          defaultModelSelection: null,
          spaceId: acme,
        });
        yield* seedProject(hub.server, {
          projectId: globexProject,
          title: "Globex",
          defaultModelSelection: null,
          spaceId: globex,
        });
        const acmeSandbox = sandboxEnvironmentIdOf(acme);
        const choose = (userId: UserId, projectId: ProjectId, requested = acmeSandbox) =>
          registry.chooseForThread({
            userId,
            requested,
            projectId,
            providerInstanceId: instanceId,
          });
        const refusal = (userId: UserId, projectId: ProjectId, requested = acmeSandbox) =>
          choose(userId, projectId, requested).pipe(
            Effect.flip,
            Effect.map((error) =>
              error._tag === "ThreadEnvironmentUnavailableError" ? error.reason : error._tag,
            ),
          );

        // Grace sees her Space's Sandbox, not Globex's; a Guest runs nothing there.
        const graces = (yield* listEnvironments(hub.server, graceCookie)).map(({ id }) => id);
        assert.include(graces, acmeSandbox);
        assert.notInclude(graces, sandboxEnvironmentIdOf(globex));
        assert.equal(yield* refusal(linus, acmeProject), "not-usable");
        assert.equal(yield* choose(grace, acmeProject), acmeSandbox);
        // Not for a Thread of another Space, though the Owner may use both.
        assert.equal(yield* refusal(owner, globexProject), "not-usable");
        assert.equal(
          yield* refusal(grace, globexProject, sandboxEnvironmentIdOf(globex)),
          "not-usable",
        );

        yield* startSandbox(hub, acme);
        const sandbox = yield* hub.sandboxOf(acme);
        const remote = (projectId: ProjectId) =>
          HubRepository.withEnvironmentCredential(
            HubRepository.hubRepositoryUrl(hub.server.url, { projectId }),
            sandbox.credential,
          );
        const advertised = (url: string) =>
          HttpClient.HttpClient.pipe(
            Effect.flatMap((client) =>
              client.execute(
                HttpClientRequest.get(`${url}/info/refs?service=git-upload-pack`).pipe(
                  HttpClientRequest.bearerToken(sandbox.credential),
                ),
              ),
            ),
            Effect.map((response) => response.status),
            Effect.provide(FetchHttpClient.layer),
            Effect.orDie,
          );
        // Its own Space's repository, and nothing of Globex's: neither a Project's nor a Thread's.
        assert.equal(yield* advertised(remote(acmeProject).url), 200);
        assert.equal(yield* advertised(remote(globexProject).url), 403);
        assert.notEqual(
          (yield* git(acmeRoot, ["ls-remote", remote(globexProject).url], {
            env: remote(globexProject).env ?? {},
          })).exitCode,
          0,
        );
        // A Globex Thread without a Project, in a folder of its own with its own repository.
        const scratchProject = ProjectId.make("project:scratch");
        const scratch = yield* seedProject(hub.server, {
          projectId: scratchProject,
          title: "No project",
          defaultModelSelection: null,
          scratch: true,
        });
        const folder = `${scratch.workspaceRoot}/globex-notes`;
        yield* Effect.promise(() => NodeFSP.mkdir(folder, { recursive: true }));
        yield* git(folder, ["init", "--quiet"]);
        const globexThread = ThreadId.make("thread:globex");
        yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:globex-thread"),
          threadId: globexThread,
          projectId: scratchProject,
          spaceId: globex,
          title: "Globex notes",
          modelSelection: { instanceId, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: folder,
        });
        assert.equal(
          yield* advertised(
            HubRepository.hubRepositoryUrl(hub.server.url, {
              projectId: scratchProject,
              scratchThreadId: globexThread,
            }),
          ),
          403,
        );
        // A Thread of Globex never moves onto Acme's Sandbox, nor is it worked through it.
        const moved = yield* registry
          .chooseForThread({
            userId: owner,
            requested: acmeSandbox,
            projectId: globexProject,
            providerInstanceId: instanceId,
            threadId: globexThread,
          })
          .pipe(Effect.flip);
        assert.equal(
          moved._tag === "ThreadEnvironmentUnavailableError" && moved.reason,
          "not-usable",
        );
        assert.isTrue(
          Option.isNone(
            yield* registry.usableBy({
              userId: owner,
              environmentId: acmeSandbox,
              threadId: globexThread,
            }),
          ),
        );
        // A Sandbox does not remove itself, and is not removed as a machine.
        assert.isFalse(yield* registry.leave(sandbox.credential));
        const removed = yield* registry
          .remove({ actorUserId: owner, environmentId: acmeSandbox })
          .pipe(Effect.flip);
        assert.equal(removed._tag, "EnvironmentAccessDeniedError");
      }).pipe(Effect.scoped),
  );

  it.live("a second Space gets a Sandbox of its own", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
      const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
      const owner = yield* ownerIdOf(hub);
      const homes: Array<string> = [];
      for (const name of ["Acme", "Globex"]) {
        const spaceId = yield* createOrganization(hub, name);
        const projectId = ProjectId.make(`project:${name}`);
        yield* seedProject(hub.server, {
          projectId,
          title: name,
          defaultModelSelection: null,
          spaceId,
        });
        yield* registry.chooseForThread({
          userId: owner,
          requested: sandboxEnvironmentIdOf(spaceId),
          projectId,
          providerInstanceId: instanceId,
        });
        yield* startSandbox(hub, spaceId);
        homes.push((yield* hub.sandboxOf(spaceId)).workspaceRoot);
      }
      assert.equal(new Set(homes).size, 2);
      const online = (yield* listEnvironments(hub.server, hub.owner)).filter(
        (environment) => environment.kind === "sandbox" && environment.status === "online",
      );
      assert.deepEqual(
        online.map(({ name }) => name),
        ["Acme Sandbox", "Globex Sandbox"],
      );
    }).pipe(Effect.scoped),
  );

  it.live("the process runtime runs it as a joined `t3 serve` child with its own base dir", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({
        sandboxLauncher: ProcessSandboxRuntime.childProcessLauncher({
          command: process.execPath,
          args: [new URL("../bin.ts", import.meta.url).pathname],
        }),
      });
      const acme = yield* createOrganization(hub, "Acme");
      const projectId = ProjectId.make("project:acme");
      yield* seedProject(hub.server, {
        projectId,
        title: "Acme",
        defaultModelSelection: null,
        spaceId: acme,
      });
      const placed = yield* hub
        .service(EnvironmentRegistry.EnvironmentRegistry)
        .chooseForThread({
          userId: yield* ownerIdOf(hub),
          requested: sandboxEnvironmentIdOf(acme),
          projectId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        })
        .pipe(Effect.result);
      yield* startSandbox(hub, acme);
      // It connected; whether it has Codex is up to the machine the test runs on.
      if (Result.isFailure(placed)) {
        assert.equal(
          placed.failure._tag === "ThreadEnvironmentUnavailableError" && placed.failure.reason,
          "provider-missing",
        );
      }
      const sandbox = (yield* listEnvironments(hub.server, hub.owner)).find(
        (environment) => environment.id === sandboxEnvironmentIdOf(acme),
      );
      assert.equal(sandbox?.status, "online");
    }).pipe(Effect.scoped),
  );

  describe.skipIf(!rootlessPodmanAvailable)("in Podman", () => {
    const run = makeTestRun();
    let image = "";
    beforeAll(() => {
      image = ensureDevImage();
    });
    afterAll(() => removeTestRunContainers(run));

    it.live(
      "the Podman runtime runs it in a container that reaches the Hub only by its socket",
      () =>
        Effect.gen(function* () {
          const entry = new URL("../bin.ts", import.meta.url).pathname;
          const checkout = new URL("../../../../", import.meta.url).pathname.replace(/\/$/u, "");
          const hub = yield* makeHub({
            sandboxRuntime: (rootDir) =>
              PodmanSandboxRuntime.layer({
                image,
                serverCommand: ["node", entry],
                codeMounts: devCodeMounts(checkout),
                rootDir,
                namePrefix: run.namePrefix,
                labels: run.labels,
              }),
          });
          const acme = yield* createOrganization(hub, "Acme");
          const projectId = ProjectId.make("project:acme");
          yield* seedProject(hub.server, {
            projectId,
            title: "Acme",
            defaultModelSelection: null,
            spaceId: acme,
          });
          // It connected; whether it has Codex is up to the image.
          yield* hub
            .service(EnvironmentRegistry.EnvironmentRegistry)
            .chooseForThread({
              userId: yield* ownerIdOf(hub),
              requested: sandboxEnvironmentIdOf(acme),
              projectId,
              providerInstanceId: ProviderInstanceId.make("codex"),
            })
            .pipe(Effect.ignore);
          // Placing it makes it; the Hub's own start (as for a Thread's first work) runs it.
          yield* startSandbox(hub, acme);
          const sandbox = (yield* listEnvironments(hub.server, hub.owner)).find(
            (environment) => environment.id === sandboxEnvironmentIdOf(acme),
          );
          assert.equal(sandbox?.status, "online");
          const container = `${run.namePrefix}${SandboxRuntime.sandboxIdOf(acme)}`;
          const mounts = JSON.parse(
            podmanResult(["container", "inspect", "--format", "{{json .Mounts}}", container])
              .stdout,
          ) as Array<{ Source: string; Destination: string }>;
          // Its git reaches the Hub's repositories through the same socket, with the credential
          // the Hub wrote and mounts read-only.
          const credentialPath = mounts.find((mount) =>
            mount.Destination.endsWith("/secrets/environment-credential.bin"),
          )!.Source;
          const remote = HubRepository.withEnvironmentCredential(
            HubRepository.hubRepositoryUrl(PodmanSandboxRuntime.SANDBOX_CONTAINER_HUB_URL, {
              projectId,
            }),
            NodeFS.readFileSync(credentialPath, "utf8"),
          );
          const listed = yield* Effect.callback<{ code: number; output: string }>((resume) => {
            NodeChildProcess.execFile(
              "podman",
              [
                ...PodmanSandboxRuntime.podmanGlobalArgs(),
                "exec",
                ...Object.entries(remote.env ?? {}).flatMap(([key, value]) => [
                  "--env",
                  `${key}=${String(value)}`,
                ]),
                container,
                "git",
                "ls-remote",
                remote.url,
              ],
              (error, stdout, stderr) =>
                resume(
                  Effect.succeed({ code: error === null ? 0 : 1, output: `${stdout}${stderr}` }),
                ),
            );
          });
          assert.equal(listed.code, 0, listed.output);
        }).pipe(Effect.scoped),
    );
  });

  it.live("is not offered by a Hub without a runtime that runs Sandboxes", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({ sandboxes: false });
      const acme = yield* createOrganization(hub, "Acme");
      const projectId = ProjectId.make("project:acme");
      yield* seedProject(hub.server, {
        projectId,
        title: "Acme",
        defaultModelSelection: null,
        spaceId: acme,
      });
      const listed = yield* listEnvironments(hub.server, hub.owner);
      assert.deepEqual(
        listed.map((environment) => environment.kind),
        ["hub"],
      );
      const refused = yield* hub
        .service(EnvironmentRegistry.EnvironmentRegistry)
        .chooseForThread({
          userId: yield* ownerIdOf(hub),
          requested: sandboxEnvironmentIdOf(acme),
          projectId,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        })
        .pipe(Effect.flip);
      assert.equal(
        refused._tag === "ThreadEnvironmentUnavailableError" && refused.reason,
        "sandbox-unavailable",
      );
    }).pipe(Effect.scoped),
  );

  it.live("a server that exits before connecting fails the start at once, with its exit code", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub({
        sandboxLauncher: () => Effect.succeed({ pid: null, exited: Effect.succeed(3) }),
      });
      const acme = yield* createOrganization(hub, "Acme");
      const projectId = ProjectId.make("project:acme");
      yield* seedProject(hub.server, {
        projectId,
        title: "Acme",
        defaultModelSelection: null,
        spaceId: acme,
      });
      // Placing it never waits for its server; the start fails when work needs it.
      yield* hub.service(EnvironmentRegistry.EnvironmentRegistry).chooseForThread({
        userId: yield* ownerIdOf(hub),
        requested: sandboxEnvironmentIdOf(acme),
        projectId,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      const failed = yield* hub
        .service(Sandboxes.Sandboxes)
        .ensureRunning({ spaceId: acme, actorUserId: undefined })
        .pipe(Effect.flip);
      assert.include(failed.message, "exit code 3");
      const listed = (yield* listEnvironments(hub.server, hub.owner)).find(
        (environment) => environment.id === sandboxEnvironmentIdOf(acme),
      );
      assert.equal(listed?.status, "failed");
      assert.include(listed?.startError ?? "", "exit code 3");
    }).pipe(Effect.scoped),
  );

  it.live(
    "stops when its Organization is archived and is deleted with it, home and credential",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
        const registry = hub.service(EnvironmentRegistry.EnvironmentRegistry);
        const lifecycle = hub.service(OrganizationLifecycle.OrganizationLifecycle);
        const owner = yield* ownerIdOf(hub);
        const acme = yield* createOrganization(hub, "Acme");
        const projectId = ProjectId.make("project:acme");
        yield* seedProject(hub.server, {
          projectId,
          title: "Acme",
          defaultModelSelection: null,
          spaceId: acme,
        });
        const sandboxId = sandboxEnvironmentIdOf(acme);
        const choose = registry.chooseForThread({
          userId: owner,
          requested: sandboxId,
          projectId,
          providerInstanceId: instanceId,
        });
        yield* choose;
        yield* startSandbox(hub, acme);
        const sandbox = yield* hub.sandboxOf(acme);
        const status = hub.server.sql<{ readonly status: string }>`
        SELECT status FROM sandboxes WHERE space_id = ${acme}
      `.pipe(Effect.map((rows) => rows.map((row) => row.status)));

        yield* lifecycle.archive(owner, acme);
        assert.deepEqual(yield* status, ["stopped"]);
        // Nothing starts it while archived.
        const refused = yield* choose.pipe(Effect.flip);
        assert.equal(
          refused._tag === "ThreadEnvironmentUnavailableError" && refused.reason,
          "not-usable",
        );
        yield* lifecycle.restore(owner, acme);
        assert.equal(yield* choose, sandboxId);
        // Chosen again it is not started until work needs it.
        assert.deepEqual(yield* status, ["stopped"]);

        yield* lifecycle.archive(owner, acme);
        yield* lifecycle.delete(owner, acme);
        assert.deepEqual(yield* status, []);
        const [row] = yield* hub.server.sql<{ readonly revokedAt: string | null }>`
        SELECT revoked_at AS "revokedAt" FROM environments WHERE environment_id = ${sandboxId}
      `;
        assert.isNotNull(row?.revokedAt ?? null);
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.access(`${hub.sandboxRoot}/sandbox-${acme}`).then(
              () => true,
              () => false,
            ),
          ),
        );
        const checked = yield* registry.checkCredential(sandbox.credential);
        assert.equal(checked._tag === "refused" && checked.reason, "credential-revoked");
        const audited = yield* hub.server.sql<{ readonly action: string }>`
        SELECT action FROM audit_log WHERE action LIKE 'sandbox.%' ORDER BY rowid
      `;
        assert.deepEqual(
          audited.map((entry) => entry.action),
          ["sandbox.create", "sandbox.start", "sandbox.stop", "sandbox.delete"],
        );
      }).pipe(Effect.scoped),
  );

  it.live("starts nothing for a Thread whose Space is no longer the Sandbox's", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub({ sandboxAdapters: idleAdapters(instanceId) });
      const owner = yield* ownerIdOf(hub);
      const acme = yield* createOrganization(hub, "Acme");
      const globex = yield* createOrganization(hub, "Globex");
      const projectId = ProjectId.make("project:acme");
      yield* seedProject(hub.server, {
        projectId,
        title: "Acme",
        defaultModelSelection: null,
        spaceId: acme,
      });
      const sandboxId = sandboxEnvironmentIdOf(acme);
      yield* hub.service(EnvironmentRegistry.EnvironmentRegistry).chooseForThread({
        userId: owner,
        requested: sandboxId,
        projectId,
        providerInstanceId: instanceId,
      });
      yield* startSandbox(hub, acme);
      const threadId = ThreadId.make("thread:acme");
      const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:acme-thread"),
        threadId,
        projectId,
        title: "Acme",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeEnvironmentId: sandboxId,
      });
      // Its Project went to Globex (ticket 12 moves such Threads; until then nothing runs).
      yield* hub.server
        .sql`UPDATE projection_projects SET space_id = ${globex} WHERE project_id = ${projectId}`;
      const executors = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
      const adapter = yield* (yield* executors.get(sandboxId)).provider.adapters.get(instanceId);
      const refused = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session:acme"),
          modelSelection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/x" },
        })
        .pipe(Effect.provideService(Scope.Scope, yield* Effect.scope), Effect.flip);
      const causes: Array<string> = [];
      for (let current: unknown = refused; typeof current === "object" && current !== null;) {
        causes.push(String((current as { readonly _tag?: unknown })._tag));
        current = (current as { readonly cause?: unknown }).cause;
      }
      assert.include(causes, "SandboxSpaceMismatchError");
    }).pipe(Effect.scoped),
  );

  it.live("starts nothing on a personal machine whose owner left the Thread's Space", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const acme = yield* createOrganization(hub, "Acme");
      const grace = UserId.make("member-1");
      yield* addMember(hub.server, { id: grace, displayName: "Grace" });
      yield* joinOrganization(hub.server, acme, grace, "member");
      const projectId = ProjectId.make("project:acme-laptop");
      yield* seedProject(hub.server, {
        projectId,
        title: "Acme",
        defaultModelSelection: null,
        spaceId: acme,
      });
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      yield* hub.server.sql`
        UPDATE environments SET owner_user_id = ${grace}, mode = 'personal'
        WHERE environment_id = ${laptop.environmentId}
      `;
      const threadId = ThreadId.make("thread:acme-laptop");
      const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
      yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:acme-laptop-thread"),
        threadId,
        projectId,
        title: "Acme on the Laptop",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeEnvironmentId: laptop.environmentId,
      });
      // Grace leaves Acme: a resume, which has no actor, finds her machine no longer usable.
      yield* hub.server.sql`DELETE FROM space_memberships WHERE user_id = ${grace}`;
      const executors = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
      const adapter = yield* (yield* executors.get(laptop.environmentId)).provider.adapters.get(
        instanceId,
      );
      const refused = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session:acme-laptop"),
          modelSelection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/x" },
        })
        .pipe(Effect.provideService(Scope.Scope, yield* Effect.scope), Effect.flip);
      const details: Array<string> = [];
      for (let current: unknown = refused; typeof current === "object" && current !== null;) {
        const failure = current as { readonly detail?: unknown; readonly message?: unknown };
        details.push(String(failure.detail ?? failure.message));
        current = (current as { readonly cause?: unknown }).cause;
      }
      assert.isTrue(
        details.some((detail) => detail.includes("no longer in its Space")),
        details.join(" | "),
      );
    }).pipe(Effect.scoped),
  );
});
