// @effect-diagnostics nodeBuiltinImport:off -- the tests read and write files on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { assert, describe, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId, UserId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { addMember } from "../auth/UserAuth.testkit.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as ProjectCheckouts from "../environment/ProjectCheckouts.ts";
import * as ThreadWorkspace from "../environment/ThreadWorkspace.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { makeHub, seedProject, type Hub } from "./HubWithEnvironments.testkit.ts";
import {
  idleAdapters,
  ownerIdOf,
  openProtocolSession,
} from "./HubWithEnvironments.scenarios.testkit.ts";

/** The Hub's workspace RPCs (what `ws.ts` calls), over the Hub's own projection and Environments. */
const threadWorkspaceOf = (hub: Hub) =>
  ThreadWorkspace.make.pipe(
    Effect.provide(Layer.mergeAll(ProjectionStore.layer, ProjectCheckouts.layer)),
    Effect.provideContext(hub.server.services as never),
  ) as Effect.Effect<ThreadWorkspace.ThreadWorkspace["Service"]>;

/** A Thread of the Owner's on the Laptop, with the Project checked out there. */
const threadOnLaptop = Effect.fn(function* () {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const hub = yield* makeHub();
  const laptop = yield* hub.join({ name: "Laptop", adapters: idleAdapters(instanceId) });
  const projectId = ProjectId.make("project:workspace");
  const { workspaceRoot: hubCheckout } = yield* seedProject(hub.server, {
    projectId,
    title: "Workspace project",
    defaultModelSelection: null,
  });
  const threadId = ThreadId.make("thread:workspace");
  yield* hub.service(Orchestrator.OrchestratorV2).dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:workspace-thread"),
    threadId,
    projectId,
    title: "Workspace",
    modelSelection: { instanceId, model: "claude-sonnet-4-6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeEnvironmentId: laptop.environmentId,
  });
  const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const laptopCheckout = Option.getOrThrow(
    yield* (yield* registry.get(laptop.environmentId)).workspace.paths.checkout(projectId),
  );
  // The Laptop's own copy differs from the Hub's, so a test sees which machine answered.
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(laptopCheckout, { recursive: true });
    await NodeFSP.writeFile(`${laptopCheckout}/README.md`, "# On the Laptop\n");
  });
  const owner = { userId: yield* ownerIdOf(hub) };
  return {
    hub,
    laptop,
    threadId,
    projectId,
    hubCheckout,
    laptopCheckout,
    owner,
    workspace: yield* threadWorkspaceOf(hub),
  };
});

describe("Hub con Environments: a Thread's files and terminals", () => {
  it.live("act on the Thread's Active environment, live, and say «environment offline»", () =>
    Effect.gen(function* () {
      const { laptop, threadId, hubCheckout, laptopCheckout, owner, workspace } =
        yield* threadOnLaptop();

      // The client sends the workspace as the Hub records it; the Laptop answers from its own.
      const read = yield* workspace.readFile(
        { cwd: hubCheckout, relativePath: "README.md", threadId },
        owner,
      );
      assert.equal(read.contents, "# On the Laptop\n");
      yield* workspace.writeFile(
        { cwd: hubCheckout, relativePath: "notes.md", contents: "laptop notes\n", threadId },
        owner,
      );
      assert.equal(
        yield* Effect.promise(() => NodeFSP.readFile(`${laptopCheckout}/notes.md`, "utf8")),
        "laptop notes\n",
      );
      const listed = yield* workspace.listEntries({ cwd: hubCheckout, threadId }, owner);
      assert.includeMembers(
        listed.entries.map((entry) => entry.path),
        ["README.md", "notes.md"],
      );

      // A terminal opens in the Laptop's checkout and streams its output live.
      const opened = yield* workspace.terminalOpen(
        { threadId, terminalId: "term-1", cwd: hubCheckout, cols: 80, rows: 24 },
        owner,
      );
      assert.equal(opened.cwd, laptopCheckout);
      const attached = yield* Deferred.make<void>();
      const output = yield* workspace
        .terminalAttach({ threadId, terminalId: "term-1" }, "viewer-1", owner)
        .pipe(
          Stream.tap((event) =>
            event.type === "snapshot" ? Deferred.succeed(attached, undefined) : Effect.void,
          ),
          Stream.filter((event) => event.type === "output"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
      yield* Deferred.await(attached);
      yield* workspace.terminalWrite({ threadId, terminalId: "term-1", data: "pwd\r" }, owner);
      const [echoed] = yield* Fiber.join(output);
      assert.equal(echoed?.type === "output" ? echoed.data : undefined, `${laptopCheckout}\r\n`);

      // A preview opens on the Laptop, and what changes there reaches the Hub as it happens.
      const preview = yield* workspace.previewOpen({ threadId }, owner);
      assert.deepEqual(
        (yield* workspace.previewList({ threadId }, owner)).sessions.map(
          (session) => session.tabId,
        ),
        [preview.tabId],
      );
      const previewChanged = yield* workspace.previewEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "resized"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* workspace.previewAdjust({ threadId, tabId: preview.tabId, zoomFactor: 1.5 }, owner);
      const [changed] = yield* Fiber.join(previewChanged);
      assert.equal(changed?.tabId, preview.tabId);

      // Off: every surface says so, and nothing typed or saved waits to run later.
      const watching = yield* workspace
        .terminalAttach({ threadId, terminalId: "term-1" }, "viewer-2", owner)
        .pipe(Stream.runDrain, Effect.flip, Effect.forkScoped);
      yield* laptop.disconnect;
      const streamEnded = yield* Fiber.join(watching);
      assert.equal(streamEnded._tag, "TerminalEnvironmentUnavailableError");
      const offlineRead = yield* workspace
        .readFile({ cwd: hubCheckout, relativePath: "README.md", threadId }, owner)
        .pipe(Effect.flip);
      assert.equal(offlineRead.failure, "environment_offline");
      assert.match(offlineRead.message, /^Environment offline: Laptop is not connected/);
      const offlineWrite = yield* workspace
        .writeFile(
          { cwd: hubCheckout, relativePath: "notes.md", contents: "while away\n", threadId },
          owner,
        )
        .pipe(Effect.flip);
      assert.equal(offlineWrite.failure, "environment_offline");
      const offlineTyping = yield* workspace
        .terminalWrite({ threadId, terminalId: "term-1", data: "ls\r" }, owner)
        .pipe(Effect.flip);
      assert.equal(offlineTyping.message, "Environment offline: Laptop is not connected.");
      const offlinePreview = yield* workspace.previewOpen({ threadId }, owner).pipe(Effect.flip);
      assert.equal(offlinePreview._tag, "PreviewEnvironmentUnavailableError");
      const offlineSearch = yield* workspace
        .searchEntries({ cwd: hubCheckout, query: "READ", limit: 10, threadId }, owner)
        .pipe(Effect.flip);
      assert.equal(offlineSearch.failure, "environment_offline");

      yield* laptop.connect;
      assert.equal(
        yield* Effect.promise(() => NodeFSP.readFile(`${laptopCheckout}/notes.md`, "utf8")),
        "laptop notes\n",
      );
      assert.equal(
        (yield* workspace.readFile({ cwd: hubCheckout, relativePath: "notes.md", threadId }, owner))
          .contents,
        "laptop notes\n",
      );
    }).pipe(Effect.scoped),
  );

  it.live("never take a User to another machine, another Project or outside the Thread", () =>
    Effect.gen(function* () {
      const { hub, laptop, threadId, hubCheckout, laptopCheckout, owner, workspace } =
        yield* threadOnLaptop();
      const member = UserId.make("member-1");
      yield* addMember(hub.server, { id: member, displayName: "Grace Hopper" });
      const { workspaceRoot: otherProject } = yield* seedProject(hub.server, {
        projectId: ProjectId.make("project:other"),
        title: "Other project",
        defaultModelSelection: null,
      });
      const refusedRead = (
        input: { readonly cwd: string; readonly relativePath: string },
        caller = owner,
      ) =>
        workspace.readFile({ ...input, threadId }, caller).pipe(
          Effect.flip,
          Effect.map((error) => error.failure),
        );
      const asked = laptop.requests.length;

      // The Owner's Laptop is theirs alone: naming its Thread does not reach it for anyone else.
      assert.equal(
        yield* refusedRead({ cwd: hubCheckout, relativePath: "README.md" }, { userId: member }),
        "workspace_path_outside_root",
      );
      assert.equal(
        (yield* workspace
          .terminalOpen({ threadId, terminalId: "term-1", cwd: hubCheckout }, { userId: member })
          .pipe(Effect.flip))._tag,
        "TerminalEnvironmentUnavailableError",
      );
      // The Thread names the machine; a folder of another Project or outside it is refused.
      assert.equal(
        yield* refusedRead({ cwd: otherProject, relativePath: "README.md" }),
        "workspace_path_outside_root",
      );
      assert.equal(
        yield* refusedRead({ cwd: hubCheckout, relativePath: "../other/README.md" }),
        "workspace_path_outside_root",
      );
      assert.equal(
        yield* refusedRead({ cwd: hubCheckout, relativePath: "/etc/hostname" }),
        "workspace_path_outside_root",
      );
      assert.equal(
        (yield* workspace
          .browse({ partialPath: "/", cwd: hubCheckout, threadId }, owner)
          .pipe(Effect.flip)).failure,
        "outside_thread_workspace",
      );
      assert.equal(
        (yield* workspace
          .terminalOpen({ threadId, terminalId: "term-1", cwd: otherProject }, owner)
          .pipe(Effect.flip))._tag,
        "TerminalEnvironmentUnavailableError",
      );
      // Without a Thread a call stays on the Hub machine, even one naming the Laptop's folder.
      yield* workspace
        .readFile({ cwd: laptopCheckout, relativePath: "README.md" }, owner)
        .pipe(Effect.exit);
      assert.deepEqual(laptop.requests.slice(asked), []);
    }).pipe(Effect.scoped),
  );
});

describe("Hub con Environments: what a machine is trusted with", () => {
  it.live("the machine refuses a workspace path whose symlinks lead outside the Thread", () =>
    Effect.gen(function* () {
      const { threadId, hubCheckout, laptopCheckout, owner, workspace } = yield* threadOnLaptop();
      const outside = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(`${NodeOS.tmpdir()}/t3-outside-`),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(`${outside}/secret.txt`, "not the Thread's\n");
        await NodeFSP.symlink(outside, `${laptopCheckout}/home-link`);
        await NodeFSP.symlink("/", `${laptopCheckout}/root-link`);
      });
      // Inside the workspace as text, outside it once the machine follows the links.
      const read = yield* workspace
        .readFile({ cwd: hubCheckout, relativePath: "home-link/secret.txt", threadId }, owner)
        .pipe(Effect.flip);
      assert.equal(read.failure, "resolved_path_outside_root");
      const write = yield* workspace
        .writeFile(
          { cwd: hubCheckout, relativePath: "home-link/planted.txt", contents: "x", threadId },
          owner,
        )
        .pipe(Effect.flip);
      assert.equal(write.failure, "resolved_path_outside_root");
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.access(`${outside}/planted.txt`).then(
            () => true,
            () => false,
          ),
        ),
      );
      const listed = yield* workspace
        .listEntries({ cwd: `${hubCheckout}/root-link`, threadId }, owner)
        .pipe(Effect.flip);
      assert.equal(listed.failure, "outside_thread_workspace");
      const terminal = yield* workspace
        .terminalOpen({ threadId, terminalId: "term-1", cwd: `${hubCheckout}/root-link` }, owner)
        .pipe(Effect.flip);
      assert.equal(
        terminal._tag === "TerminalEnvironmentUnavailableError" ? terminal.reason : terminal._tag,
        "outside_thread_workspace",
      );
      // What the workspace does hold still answers.
      assert.equal(
        (yield* workspace.readFile(
          { cwd: hubCheckout, relativePath: "README.md", threadId },
          owner,
        )).contents,
        "# On the Laptop\n",
      );
    }).pipe(Effect.scoped),
  );

  it.live("a machine's preview events reach clients only for Threads it runs", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      const workspace = yield* threadWorkspaceOf(hub);
      const received = yield* workspace.previewEvents.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      const closed = (threadId: string) => ({
        type: "closed",
        threadId,
        tabId: "tab-1",
        createdAt: "1970-01-01T00:00:00.000Z",
        serverEpoch: "epoch",
        revision: 1,
      });
      // A Thread on the Hub machine, which this machine has no say over.
      yield* opened.machine.sendPreviewEvent(closed("thread:elsewhere"));
      yield* opened.machine.sendPreviewEvent(closed(opened.threadId));
      const [first] = yield* Fiber.join(received);
      assert.equal(first?.threadId, opened.threadId);
    }).pipe(Effect.scoped),
  );

  it.live("cleaning up a Thread's terminals waits for its machine instead of reporting done", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const opened = yield* openProtocolSession(hub);
      const registry = hub.service(EnvironmentExecutor.EnvironmentExecutorRegistry);
      yield* opened.machine.disconnect;
      const cleanup = yield* ResourceCleanupService.onThreadMachine(
        registry,
        opened.threadId,
        (forward) => forward.call("terminal.close", { threadId: opened.threadId }),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(cleanup));
    }).pipe(Effect.scoped),
  );
});
