// @effect-diagnostics nodeBuiltinImport:off -- the tests read and write files on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointRef,
  CommandId,
  HUB_MACHINE_ENVIRONMENT_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as HubRepository from "../checkpointing/HubRepository.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { addMember } from "../auth/UserAuth.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { makeHub, seedProject, type TestEnvironment } from "./HubWithEnvironments.testkit.ts";
import {
  idleAdapters,
  loadFixture,
  replayOn,
  ownerIdOf,
  git,
  awaitUploaded,
  withEditingTurns,
  dispatchMove,
  settledMove,
  readText,
  checkoutOn,
  exists,
} from "./HubWithEnvironments.scenarios.testkit.ts";

const SCRATCH_FOLDER = "2026-11-06-quick-notes-scratch1";

/** A Thread without a Project whose recorded turn on the Laptop wrote `notes.md`, uploaded. */
const scratchTurnOnLaptop = Effect.fn(function* (input: { readonly desktop: boolean }) {
  const loaded = yield* loadFixture("simple");
  const hub = yield* makeHub();
  const laptop = yield* hub.join({
    name: "Laptop",
    adapters: withEditingTurns(loaded.adapters, {
      file: "notes.md",
      content: "Written on the Laptop",
    }),
  });
  const desktop = input.desktop
    ? yield* hub.join({
        name: "Desktop",
        adapters: idleAdapters(loaded.variant.modelSelection.instanceId),
      })
    : undefined;
  yield* replayOn(hub, laptop, loaded, { scratchFolder: SCRATCH_FOLDER });
  const [threadId] = loaded.materialized.projectionThreadIds;
  assert.isDefined(threadId);
  yield* awaitUploaded(hub, threadId, 1);
  const { thread } = yield* hub
    .service(Orchestrator.OrchestratorV2)
    .getThreadProjection(threadId)
    .pipe(Effect.orDie);
  return {
    hub,
    laptop,
    desktop,
    threadId,
    projectId: thread.projectId,
    owner: yield* ownerIdOf(hub),
    laptopFolder: `${yield* checkoutOn(hub, laptop, thread.projectId)}/${SCRATCH_FOLDER}`,
  };
});

describe("Hub con Environments: Threads without a Project", () => {
  it.live(
    "its folder is its own repository on the machine, uploaded to its own Hub repository",
    () =>
      Effect.gen(function* () {
        const { hub, laptop, threadId, projectId, laptopFolder } = yield* scratchTurnOnLaptop({
          desktop: false,
        });
        // The turn ran in the Thread's own folder on the Laptop, a git repository of its own.
        assert.equal(
          yield* readText(`${laptopFolder}/notes.md`),
          "Written on the Laptop (turn 1)\n",
        );
        assert.isTrue(yield* exists(`${laptopFolder}/.git`));

        // Its checkpoints are in the Thread's own repository on the Hub, not a shared one.
        const repositories = hub.service(HubRepository.HubRepositories);
        const projection = yield* hub
          .service(Orchestrator.OrchestratorV2)
          .getThreadProjection(threadId);
        const refs = projection.checkpoints
          .filter((checkpoint) => checkpoint.status === "ready")
          .map((checkpoint) => checkpoint.ref);
        assert.isNotEmpty(refs);
        assert.deepEqual(
          Option.getOrThrow(yield* repositories.threads.repositoryOfThread(threadId)).key,
          {
            projectId,
            scratchThreadId: threadId,
          },
        );
        assert.isTrue(yield* repositories.hasRefs({ projectId, scratchThreadId: threadId }, refs));
        assert.isFalse(yield* repositories.hasRefs({ projectId }, refs));

        // The turn's diffs open on the Hub with the Laptop offline.
        yield* laptop.disconnect;
        const diffs = hub.service(CheckpointDiffQuery.CheckpointDiffQuery);
        const turn = yield* diffs.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
        assert.include(turn.diff, "+Written on the Laptop (turn 1)");
      }).pipe(Effect.scoped),
  );

  it.live("it moves with its folder, and what the machine it returns to had is kept", () =>
    Effect.gen(function* () {
      const { hub, laptop, desktop, threadId, projectId, owner, laptopFolder } =
        yield* scratchTurnOnLaptop({ desktop: true });
      assert.isDefined(desktop);
      yield* Effect.promise(() => NodeFSP.writeFile(`${laptopFolder}/manual.txt`, "by hand\n"));
      // The folder's own history: a commit on its branch, and a repository nested in it.
      const commit = ["-c", "user.email=a@b.c", "-c", "user.name=A", "commit", "--quiet"];
      yield* git(laptopFolder, ["checkout", "--quiet", "-b", "notes"]);
      yield* git(laptopFolder, ["add", "notes.md"]);
      yield* git(laptopFolder, [...commit, "-m", "Notes so far"]);
      yield* Effect.promise(() => NodeFSP.mkdir(`${laptopFolder}/vendor`));
      yield* git(`${laptopFolder}/vendor`, ["init", "--quiet"]);

      yield* dispatchMove(hub, {
        commandId: "command:scratch-to-desktop",
        threadId,
        target: desktop.environmentId,
        actor: owner,
      });
      const moved = yield* settledMove(hub, threadId);
      assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
      assert.equal(moved.activeEnvironmentId, desktop.environmentId);
      assert.equal(moved.move?.continuesFrom?.kind, "final");
      // Its own folder on the Desktop, never a worktree, with the turn's file and the manual one.
      const desktopFolder = `${yield* checkoutOn(hub, desktop, projectId)}/${SCRATCH_FOLDER}`;
      assert.equal(moved.worktreePath, desktopFolder);
      assert.equal(
        yield* readText(`${desktopFolder}/notes.md`),
        "Written on the Laptop (turn 1)\n",
      );
      assert.equal(yield* readText(`${desktopFolder}/manual.txt`), "by hand\n");
      // The folder's branch and its commit came along, checked out as on the Laptop.
      assert.equal(
        (yield* git(desktopFolder, ["log", "-1", "--format=%s"])).stdout.trim(),
        "Notes so far",
      );
      assert.equal(
        (yield* git(desktopFolder, ["symbolic-ref", "--short", "HEAD"])).stdout.trim(),
        "notes",
      );
      // The nested repository stays behind, and the Thread says so.
      const { turnItems } = yield* hub
        .service(Orchestrator.OrchestratorV2)
        .getThreadProjection(threadId);
      const notice = turnItems.find((item) => item.type === "system_notice");
      assert.isTrue(notice?.type === "system_notice" && notice.message.includes("vendor"));

      // Back to the Laptop, where its old folder got a change the Hub never saw: it is kept.
      yield* Effect.promise(() => NodeFSP.writeFile(`${laptopFolder}/stale.txt`, "left behind\n"));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(`${desktopFolder}/desktop.txt`, "on desktop\n"),
      );
      yield* dispatchMove(hub, {
        commandId: "command:scratch-back-to-laptop",
        threadId,
        target: laptop.environmentId,
        actor: owner,
      });
      const back = yield* settledMove(hub, threadId);
      assert.equal(back.move?.status, "switched", back.move?.failure?.message);
      assert.equal(back.worktreePath, laptopFolder);
      assert.equal(yield* readText(`${laptopFolder}/desktop.txt`), "on desktop\n");
      assert.isFalse(yield* exists(`${laptopFolder}/stale.txt`));
      const [setAside] = back.move?.setAsideRefs ?? [];
      assert.isDefined(setAside);
      assert.include(setAside, HubRepository.threadRefPrefixes(threadId)[1]);
      const kept = yield* git(laptopFolder, ["show", `${setAside}:stale.txt`]);
      assert.equal(kept.stdout, "left behind\n");
      // ... and not only on the Laptop: it goes to the Thread's repository on the Hub too.
      const repositories = hub.service(HubRepository.HubRepositories);
      assert.isTrue(
        yield* repositories.hasRefs({ projectId, scratchThreadId: threadId }, [
          CheckpointRef.make(setAside),
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.live("a folder from before folders got git gets its repository, and then moves", () =>
    Effect.gen(function* () {
      const { hub, laptop, desktop, threadId, projectId, owner, laptopFolder } =
        yield* scratchTurnOnLaptop({ desktop: true });
      assert.isDefined(desktop);
      // As a Thread from before: its folder has no repository.
      yield* Effect.promise(() => NodeFSP.rm(`${laptopFolder}/.git`, { recursive: true }));
      const asked = laptop.requests.length;
      yield* dispatchMove(hub, {
        commandId: "command:old-scratch-to-desktop",
        threadId,
        target: desktop.environmentId,
        actor: owner,
      });
      const moved = yield* settledMove(hub, threadId);
      assert.equal(moved.move?.status, "switched", moved.move?.failure?.message);
      assert.equal(moved.move?.continuesFrom?.kind, "final");
      // Once the move ends the Hub asks the Laptop what it kept, which captures its folder: the
      // test ends after that, never while its git still writes there.
      yield* laptop.awaitAnswered("move.recover", asked);
      const desktopFolder = `${yield* checkoutOn(hub, desktop, projectId)}/${SCRATCH_FOLDER}`;
      assert.equal(
        yield* readText(`${desktopFolder}/notes.md`),
        "Written on the Laptop (turn 1)\n",
      );
      assert.isTrue(yield* exists(`${laptopFolder}/.git`));
    }).pipe(Effect.scoped),
  );

  it.live(
    "its repository serves only the machine that runs it; the scratch Project has no shared one",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const hub = yield* makeHub();
        const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
        const desktop = yield* hub.join({ name: "Desktop", adapters: idleAdapters(instanceId) });
        // Another User's machine: Grace's.
        yield* addMember(hub.server, { id: "member-1", displayName: "Grace Hopper" });
        const tablet = yield* hub.join({ name: "Tablet", adapters: idleAdapters(instanceId) });
        yield* hub.server.sql`
          UPDATE environments SET owner_user_id = 'member-1'
          WHERE environment_id = ${tablet.environmentId}
        `;
        const projectId = ProjectId.make("project:scratch");
        const { workspaceRoot } = yield* seedProject(hub.server, {
          projectId,
          title: "No project",
          defaultModelSelection: null,
          scratch: true,
        });
        const threadId = ThreadId.make("thread:scratch-on-laptop");
        const owner = yield* ownerIdOf(hub);
        const create = (id: string, worktreePath: string) =>
          hub
            .service(ThreadManagementService.ThreadManagementService)
            .dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:${id}`),
              threadId: ThreadId.make(id),
              projectId,
              title: "Quick notes",
              modelSelection: { instanceId, model: "claude-sonnet-4-6" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath,
              activeEnvironmentId: laptop.environmentId,
              ownerUserId: owner,
            })
            .pipe(CommandActor.actAs(owner));
        // A folder outside the scratch folder is a worktree, still made on the Hub machine only.
        assert.isTrue(Exit.isFailure(yield* Effect.exit(create("thread:elsewhere", "/elsewhere"))));
        // As ThreadLaunchService makes it: its own folder in the scratch folder, on the Laptop.
        yield* create(threadId, `${workspaceRoot}/${SCRATCH_FOLDER}`);
        const { thread } = yield* hub
          .service(Orchestrator.OrchestratorV2)
          .getThreadProjection(threadId);
        assert.equal(thread.activeEnvironmentId, laptop.environmentId);

        // The Laptop's folder, with the Thread's working branch to upload.
        const folder = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(`${NodeOS.tmpdir()}/t3-scratch-folder-`),
        );
        yield* git(folder, ["init", "--quiet"]);
        yield* git(folder, [
          "-c",
          "user.email=a@b.c",
          "-c",
          "user.name=A",
          "commit",
          "--allow-empty",
          "-m",
          "x",
        ]);
        const headRef = `${HubRepository.threadRefPrefixes(threadId)[0]}head`;
        yield* git(folder, ["update-ref", headRef, "HEAD"]);
        const urlOf = (key: HubRepository.HubRepositoryKey) =>
          HubRepository.hubRepositoryUrl(hub.server.url, key);
        const on = (machine: TestEnvironment, url: string, ...args: ReadonlyArray<string>) => {
          const remote = HubRepository.withEnvironmentCredential(url, machine.credential);
          return git(folder, [args[0]!, remote.url, ...args.slice(1)], { env: remote.env ?? {} });
        };
        const advertised = (machine: TestEnvironment, url: string) =>
          HttpClient.HttpClient.pipe(
            Effect.flatMap((client) =>
              client.execute(
                HttpClientRequest.get(`${url}/info/refs?service=git-upload-pack`).pipe(
                  HttpClientRequest.bearerToken(machine.credential),
                ),
              ),
            ),
            Effect.map((response) => response.status),
            Effect.provide(FetchHttpClient.layer),
            Effect.orDie,
          );
        const own = urlOf({ projectId, scratchThreadId: threadId });
        assert.include(own, `/api/git/thread/${encodeURIComponent(threadId)}`);

        // The Laptop runs it: it uploads to and reads the Thread's own repository.
        const pushed = yield* on(laptop, own, "push", `+${headRef}:${headRef}`);
        assert.equal(pushed.exitCode, 0, pushed.stderr);
        assert.include((yield* on(laptop, own, "ls-remote")).stdout, headRef);
        // It has no Project branches: nothing is written beside the Thread's refs.
        assert.notEqual(
          (yield* on(laptop, own, "push", "HEAD:refs/t3/project/heads/main")).exitCode,
          0,
        );
        assert.notInclude((yield* on(laptop, own, "ls-remote")).stdout, "refs/t3/project/");

        // Another machine of the same User, and another User's, neither read nor write it.
        assert.equal(yield* advertised(desktop, own), 403);
        assert.equal(yield* advertised(tablet, own), 403);
        assert.notEqual((yield* on(desktop, own, "push", `+HEAD:${headRef}`)).exitCode, 0);
        assert.notEqual((yield* on(tablet, own, "ls-remote")).exitCode, 0);

        // No machine reaches a repository shared by every Thread without a Project.
        assert.equal(yield* advertised(laptop, urlOf({ projectId })), 404);
        assert.equal(yield* advertised(desktop, urlOf({ projectId })), 404);
        // A Thread in a Project has no repository of its own.
        assert.equal(
          yield* advertised(laptop, urlOf({ projectId, scratchThreadId: ThreadId.make("nope") })),
          404,
        );
      }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: where a Thread elsewhere works", () => {
  it.live("only a Thread without a Project's folder is found in a checkout on every machine", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claudeAgent");
      const hub = yield* makeHub();
      const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
      const projectId = ProjectId.make("project:normal");
      const { workspaceRoot } = yield* seedProject(hub.server, {
        projectId,
        title: "Normal",
        defaultModelSelection: null,
      });
      const create = (id: string, project: ProjectId, worktreePath: string) =>
        hub.service(Orchestrator.OrchestratorV2).dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${id}`),
          threadId: ThreadId.make(id),
          projectId: project,
          title: id,
          modelSelection: { instanceId, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath,
          activeEnvironmentId: laptop.environmentId,
        });
      const locationOf = Effect.fn(function* (id: string) {
        const [row] = yield* hub.server.sql<{ readonly location: string | null }>`
          SELECT worktree_location_json AS location FROM orchestration_v2_projection_threads
          WHERE thread_id = ${id}
        `;
        assert.isDefined(row);
        return row.location === null ? null : JSON.parse(row.location);
      });

      // A Project's Thread on the Laptop keeps the Laptop's own path, even one that reads like a
      // folder in the Hub's checkout.
      yield* create("thread:normal-elsewhere", projectId, `${workspaceRoot}/nested`);
      assert.deepEqual(yield* locationOf("thread:normal-elsewhere"), {
        base: "host",
        environmentId: laptop.environmentId,
        path: `${workspaceRoot}/nested`,
      });

      // A scratch folder's Thread whose Project is not projected yet: nothing is frozen.
      const baseDir = hub.service(ServerConfig.ServerConfig).baseDir;
      yield* create(
        "thread:scratch-early",
        ProjectId.make("project:scratch-later"),
        `${baseDir}/scratch/${SCRATCH_FOLDER}`,
      );
      assert.isNull(yield* locationOf("thread:scratch-early"));
    }).pipe(Effect.scoped),
  );

  it.live(
    "the Hub machine never makes or fills a repository shared by Threads without a Project",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const projectId = ProjectId.make("project:scratch");
        yield* seedProject(hub.server, {
          projectId,
          title: "No project",
          defaultModelSelection: null,
          scratch: true,
        });
        const repositories = hub.service(HubRepository.HubRepositories);
        const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
        const hubMachine = yield* registry.get(HUB_MACHINE_ENVIRONMENT_ID);
        const folder = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(`${NodeOS.tmpdir()}/t3-scratch-shared-`),
        );
        yield* git(folder, ["init", "--quiet"]);
        yield* git(folder, [
          "-c",
          "user.email=a@b.c",
          "-c",
          "user.name=A",
          "commit",
          "--allow-empty",
          "-m",
          "x",
        ]);
        const ref = CheckpointRef.make("refs/t3/orchestration-v2/checkpoints/shared/ordinal/1");
        yield* git(folder, ["update-ref", ref, "HEAD"]);
        const pushed = yield* Effect.exit(
          hubMachine.workspace.hubRepository.push({
            cwd: folder,
            projectId,
            checkpointRefs: [ref],
          }),
        );
        assert.isTrue(Exit.isFailure(pushed));
        assert.isFalse(yield* repositories.hasRefs({ projectId }, [ref]));
        const shared = `${repositories.root}/${repositories.directoryOf({ projectId })}`;
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.access(shared).then(
              () => true,
              () => false,
            ),
          ),
        );
      }).pipe(Effect.scoped),
  );
});
