/**
 * Where workspace RPCs (files, search, browse, terminals, previews) run: one naming a Thread on its
 * Active environment, inside its workspace there; one naming none on the Hub machine. The machine
 * comes from the Thread, never from a client path (`docs/internals/overview.md`, «Workspace RPCs»).
 */
import {
  FilesystemBrowseError,
  type FilesystemBrowseInput,
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type PreviewAdjustInput,
  type PreviewCloseInput,
  PreviewEnvironmentUnavailableError,
  type PreviewError,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewOpenInput,
  type PreviewReportStatusInput,
  type PreviewResizeInput,
  type ProjectId,
  ProjectListEntriesError,
  type ProjectListEntriesInput,
  type ProjectListIgnoredFilesInput,
  ProjectReadFileError,
  type ProjectReadFileInput,
  ProjectSearchContentsError,
  type ProjectSearchContentsInput,
  ProjectSearchEntriesError,
  type ProjectSearchEntriesInput,
  ProjectWriteFileError,
  type ProjectWriteFileInput,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  TerminalEnvironmentUnavailableError,
  type TerminalError,
  type TerminalObserveInput,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalWriteInput,
  ThreadId,
  type UserId,
} from "@t3tools/contracts";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as EnvironmentRegistry from "../environments/EnvironmentRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { terminalOutputStream } from "../terminal/OutputProtocol.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import { makeWorkspaceRpcCalls } from "../workspace/WorkspaceRpcCalls.ts";
import * as EnvironmentExecutor from "./EnvironmentExecutor.ts";
import * as ProjectCheckouts from "./ProjectCheckouts.ts";
import * as RemoteEnvironments from "./RemoteEnvironments.ts";
import { locateInCheckout } from "./WorkspaceLocation.ts";

/** Who asks: the session's User, whose rules a forwarded call keeps to. */
export interface WorkspaceCaller {
  readonly userId: UserId | undefined;
}

type Route =
  | { readonly _tag: "local" }
  | {
      readonly _tag: "remote";
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly forward: EnvironmentExecutor.EnvironmentWorkspaceForward;
      /** The Thread's workspace as the Hub machine records it, which clients send. */
      readonly hubBase: string;
      /** The same workspace on the Thread's machine: the root every forwarded path is under. */
      readonly remoteBase: string;
    }
  | { readonly _tag: "offline"; readonly name: string | undefined }
  | { readonly _tag: "refused" };

const LOCAL: Route = { _tag: "local" };
const REFUSED: Route = { _tag: "refused" };

const offlineMessage = (name: string | undefined) =>
  name === undefined
    ? "Environment offline: this Thread has no Environment right now. Move it to one to use its files and terminals."
    : `Environment offline: ${name} is not connected. Start it to use this Thread's files and terminals.`;
const REFUSED_MESSAGE = "That is outside this Thread's workspace.";

/** A path inside a workspace, `/`-separated; undefined when it leaves it or names another root. */
const relativeInside = (path: string): string | undefined => {
  if (path.startsWith("~") || path.startsWith("/") || path.startsWith("\\")) return undefined;
  if (isWindowsAbsolutePath(path)) return undefined;
  const segments = path.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  return segments.includes("..") ? undefined : segments.length === 0 ? "." : segments.join("/");
};

const isAbsolute = (path: string) =>
  path.startsWith("/") || path.startsWith("\\") || isWindowsAbsolutePath(path);

export const make = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const projections = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
  const checkouts = yield* Effect.serviceOption(ProjectCheckouts.ProjectCheckouts);
  const environments = yield* Effect.serviceOption(EnvironmentRegistry.EnvironmentRegistry);
  const remoteEnvironments = yield* Effect.serviceOption(RemoteEnvironments.RemoteEnvironments);
  const hubMachine = Option.isSome(registry)
    ? yield* Effect.option(registry.value.get(registry.value.hubMachineEnvironmentId))
    : Option.none();
  // The Hub machine's executor's services; a host built without the registry has its own.
  const hubMachineRpc = Option.flatMap(hubMachine, (executor) => executor.workspace.rpc);
  const hostRpc = Option.all({
    entries: yield* Effect.serviceOption(WorkspaceEntries.WorkspaceEntries),
    files: yield* Effect.serviceOption(WorkspaceFileSystem.WorkspaceFileSystem),
    terminals: yield* Effect.serviceOption(TerminalManager.TerminalManager),
    previews: yield* Effect.serviceOption(PreviewManager.PreviewManager),
    ports: yield* Effect.serviceOption(PortScanner.PortDiscovery),
  });
  const localRpc = Option.isSome(hubMachineRpc) ? hubMachineRpc : hostRpc;
  const local = Option.match(localRpc, {
    onSome: Effect.succeed,
    onNone: () => Effect.die(new Error("This server has no workspace services.")),
  });
  const localCalls = Effect.map(local, makeWorkspaceRpcCalls);

  /** The Thread's workspace on its own machine, or why it cannot be reached from here. */
  const route = Effect.fn("ThreadWorkspace.route")(function* (
    threadId: string | undefined,
    caller: WorkspaceCaller,
  ) {
    if (
      threadId === undefined ||
      Option.isNone(registry) ||
      Option.isNone(projections) ||
      Option.isNone(checkouts) ||
      Option.isNone(environments)
    ) {
      return LOCAL;
    }
    const environmentId = yield* registry.value.activeEnvironment(ThreadId.make(threadId));
    // A draft, or a Thread on the Hub machine: the Hub machine's services answer, as before.
    if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) return LOCAL;
    if (environmentId === EnvironmentExecutor.NO_ENVIRONMENT_ID) {
      return { _tag: "offline", name: undefined } satisfies Route;
    }
    const usable = yield* environments.value
      .usableBy({ userId: caller.userId, environmentId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(usable)) return REFUSED;
    const name = usable.value.name;
    const offline: Route = { _tag: "offline", name };
    const executor = yield* Effect.option(registry.value.get(environmentId));
    if (Option.isNone(executor) || Option.isNone(executor.value.workspace.forward)) return offline;
    const thread = yield* Effect.option(projections.value.getThread(ThreadId.make(threadId)));
    if (Option.isNone(thread) || Option.isNone(hubMachine)) return REFUSED;
    const projectId: ProjectId = thread.value.projectId;
    const hubCheckout = yield* hubMachine.value.workspace.paths.checkout(projectId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    // A worktree the machine cannot resolve is refused, never swapped for the main checkout.
    const remoteWorktree = yield* EnvironmentExecutor.worktreeOn(
      registry.value,
      checkouts.value,
      executor.value,
      thread.value,
    ).pipe(Effect.option);
    if (Option.isNone(remoteWorktree)) return REFUSED;
    const remoteCheckout = yield* executor.value.workspace.paths.checkout(projectId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    const hubBase = thread.value.worktreePath ?? hubCheckout;
    const remoteBase = remoteWorktree.value ?? remoteCheckout;
    if (hubBase === null || remoteBase === null) return REFUSED;
    return {
      _tag: "remote",
      environmentId,
      name,
      forward: executor.value.workspace.forward.value,
      hubBase,
      remoteBase,
    } satisfies Route;
  });

  /**
   * A path inside the Thread's workspace, relative to its root (`remoteBase`). Clients send the
   * workspace as the Hub records it or as the machine reported it; anything else is outside. The
   * machine resolves it against the root and refuses what its symlinks take outside.
   */
  const onMachine = (
    route: Extract<Route, { _tag: "remote" }>,
    absolute: string,
  ): string | undefined => {
    for (const base of [route.hubBase, route.remoteBase]) {
      const location = locateInCheckout({
        environmentId: HUB_MACHINE_ENVIRONMENT_ID,
        checkout: base,
        absolute,
      });
      if (location.base === "checkout") return location.path;
    }
    return undefined;
  };

  const fileFailure = (route: Route, input: { cwd: string; relativePath: string }) =>
    route._tag === "offline"
      ? {
          cwd: input.cwd,
          relativePath: input.relativePath,
          failure: "environment_offline" as const,
          message: offlineMessage(route.name),
        }
      : {
          cwd: input.cwd,
          relativePath: input.relativePath,
          failure: "workspace_path_outside_root" as const,
          message: REFUSED_MESSAGE,
        };

  const entriesFailure = (route: Route) =>
    route._tag === "offline"
      ? { failure: "environment_offline" as const, message: offlineMessage(route.name) }
      : { failure: "outside_thread_workspace" as const, message: REFUSED_MESSAGE };

  /** A call its Thread names the machine for, with that call's own offline and refused errors. */
  const threadCall = Effect.fn("ThreadWorkspace.threadCall")(function* <A, E>(
    threadId: string | undefined,
    caller: WorkspaceCaller,
    refuse: (route: Route) => E,
    runLocal: (rpc: EnvironmentExecutor.EnvironmentWorkspaceRpc) => Effect.Effect<A, E>,
    runRemote: (
      forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
      route: Extract<Route, { _tag: "remote" }>,
    ) => Effect.Effect<A, E | EnvironmentExecutor.EnvironmentExecutorUnavailableError> | undefined,
  ): Effect.fn.Return<A, E> {
    const where = yield* route(threadId, caller);
    if (where._tag === "local") return yield* Effect.flatMap(local, runLocal);
    if (where._tag !== "remote") return yield* Effect.fail(refuse(where));
    const call = runRemote(where.forward, where);
    if (call === undefined) return yield* Effect.fail(refuse(REFUSED));
    return yield* (
      call as Effect.Effect<A, E | EnvironmentExecutor.EnvironmentExecutorUnavailableError>
    ).pipe(
      Effect.catchTags({
        EnvironmentExecutorUnavailableError: () =>
          Effect.fail(refuse({ _tag: "offline", name: where.name })),
      }),
    ) as Effect.Effect<A, E>;
  });

  /** A call on a folder: the folder must be inside the Thread's workspace, resolved onto its machine. */
  const routed = <I extends { readonly cwd: string; readonly threadId?: string | undefined }, A, E>(
    input: I,
    caller: WorkspaceCaller,
    runLocal: (input: I) => Effect.Effect<A, E>,
    runRemote: (
      forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
      input: I,
      route: Extract<Route, { _tag: "remote" }>,
    ) => Effect.Effect<A, E | EnvironmentExecutor.EnvironmentExecutorUnavailableError> | undefined,
    refuse: (route: Route) => E,
  ): Effect.Effect<A, E> =>
    threadCall(
      input.threadId,
      caller,
      refuse,
      () => runLocal(input),
      (forward, where) => {
        const cwd = onMachine(where, input.cwd);
        return cwd === undefined ? undefined : runRemote(forward, { ...input, cwd }, where);
      },
    );

  const withoutThread = <A extends { readonly threadId?: unknown }>({
    threadId: _threadId,
    ...rest
  }: A) => rest;

  const terminalUnavailable =
    (threadId: string) =>
    (route: Route): TerminalError =>
      new TerminalEnvironmentUnavailableError({
        threadId,
        reason: route._tag === "offline" ? "environment_offline" : "outside_thread_workspace",
        ...(route._tag === "offline" && route.name !== undefined
          ? { environmentName: route.name }
          : {}),
      });

  const previewUnavailable =
    (threadId: string) =>
    (route: Route): PreviewError =>
      new PreviewEnvironmentUnavailableError({
        threadId,
        reason: route._tag === "offline" ? "environment_offline" : "outside_thread_workspace",
        ...(route._tag === "offline" && route.name !== undefined
          ? { environmentName: route.name }
          : {}),
      });

  /** A terminal call: its Thread names the machine; the folders it names must be the Thread's. */
  const terminalCall = <I extends { readonly threadId: string }, A>(
    input: I,
    caller: WorkspaceCaller,
    runLocal: (
      terminals: TerminalManager.TerminalManager["Service"],
    ) => Effect.Effect<A, TerminalError>,
    runRemote: (
      forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
      route: Extract<Route, { _tag: "remote" }>,
    ) =>
      | Effect.Effect<A, TerminalError | EnvironmentExecutor.EnvironmentExecutorUnavailableError>
      | undefined,
  ): Effect.Effect<A, TerminalError> =>
    threadCall(
      input.threadId,
      caller,
      terminalUnavailable(input.threadId),
      (rpc) => runLocal(rpc.terminals),
      runRemote,
    );

  const previewCall = <A>(
    threadId: string,
    caller: WorkspaceCaller,
    runLocal: (
      previews: PreviewManager.PreviewManager["Service"],
    ) => Effect.Effect<A, PreviewError>,
    runRemote: (
      forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
    ) => Effect.Effect<A, PreviewError | EnvironmentExecutor.EnvironmentExecutorUnavailableError>,
  ): Effect.Effect<A, PreviewError> =>
    threadCall(
      threadId,
      caller,
      previewUnavailable(threadId),
      (rpc) => runLocal(rpc.previews),
      runRemote,
    );

  /** The folders a terminal names, resolved onto the Thread's machine; undefined if outside. */
  const terminalFolders = <I extends TerminalAttachInput>(
    route: Extract<Route, { _tag: "remote" }>,
    input: I,
  ): I | undefined => {
    const cwd = input.cwd === undefined ? undefined : onMachine(route, input.cwd);
    if (input.cwd !== undefined && cwd === undefined) return undefined;
    const worktreePath =
      input.worktreePath === undefined || input.worktreePath === null
        ? input.worktreePath
        : onMachine(route, input.worktreePath);
    if (worktreePath === undefined && input.worktreePath !== undefined) return undefined;
    return {
      ...input,
      ...(cwd === undefined ? {} : { cwd }),
      ...(input.worktreePath === undefined ? {} : { worktreePath }),
    };
  };

  /**
   * Terminals a caller opened or attached on another machine, by (User, Thread, terminal): typing
   * and resizing skip the full route and only check the Thread is still on that machine's socket.
   */
  const openTerminals = new Map<
    string,
    {
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly forward: EnvironmentExecutor.EnvironmentWorkspaceForward;
    }
  >();
  const terminalKey = (
    input: { readonly threadId: string; readonly terminalId: string },
    caller: WorkspaceCaller,
  ) => `${caller.userId ?? ""}\u0000${input.threadId}\u0000${input.terminalId}`;
  const remember = (
    input: { readonly threadId: string; readonly terminalId: string },
    caller: WorkspaceCaller,
    where: Extract<Route, { _tag: "remote" }>,
  ) =>
    Effect.sync(() => {
      openTerminals.set(terminalKey(input, caller), {
        environmentId: where.environmentId,
        name: where.name,
        forward: where.forward,
      });
    });

  /** A call on an open terminal: the remembered machine while it still holds the Thread. */
  const openTerminalCall = Effect.fn("ThreadWorkspace.openTerminalCall")(function* <
    I extends { readonly threadId: string; readonly terminalId: string },
    A,
  >(
    input: I,
    caller: WorkspaceCaller,
    runLocal: (
      terminals: TerminalManager.TerminalManager["Service"],
    ) => Effect.Effect<A, TerminalError>,
    runRemote: (
      forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
    ) => Effect.Effect<A, TerminalError | EnvironmentExecutor.EnvironmentExecutorUnavailableError>,
  ): Effect.fn.Return<A, TerminalError> {
    {
      const key = terminalKey(input, caller);
      const known = openTerminals.get(key);
      if (known !== undefined && Option.isSome(registry)) {
        const current = yield* Effect.option(registry.value.get(known.environmentId));
        const active = yield* registry.value.activeEnvironment(ThreadId.make(input.threadId));
        const forward = Option.flatMap(current, (executor) => executor.workspace.forward);
        if (
          active === known.environmentId &&
          Option.isSome(forward) &&
          forward.value === known.forward
        ) {
          return yield* runRemote(known.forward).pipe(
            Effect.catchTags({
              EnvironmentExecutorUnavailableError: () =>
                Effect.fail(
                  terminalUnavailable(input.threadId)({ _tag: "offline", name: known.name }),
                ),
            }),
          );
        }
        // It moved, or its machine reconnected or left: authorize it again.
        openTerminals.delete(key);
      }
      return yield* terminalCall(input, caller, runLocal, (forward) => runRemote(forward));
    }
  });

  /** Ends when the caller may no longer use the Environment, checked whenever executors change. */
  const untilUnusable = (environmentId: EnvironmentId, caller: WorkspaceCaller) =>
    Option.isNone(registry) || Option.isNone(environments)
      ? Effect.never
      : Effect.scoped(
          Effect.gen(function* () {
            const changes = yield* registry.value.changes;
            while (true) {
              yield* PubSub.take(changes);
              const usable = yield* environments.value
                .usableBy({ userId: caller.userId, environmentId })
                .pipe(Effect.orElseSucceed(() => Option.none()));
              if (Option.isNone(usable)) return;
            }
          }),
        );

  const terminalStream = (
    input: TerminalAttachInput,
    caller: WorkspaceCaller,
    mode: "attach" | "observe",
    viewerId: string | undefined,
    runLocal: (
      terminals: TerminalManager.TerminalManager["Service"],
    ) => Stream.Stream<TerminalAttachStreamEvent, TerminalError>,
  ): Stream.Stream<TerminalAttachStreamEvent, TerminalError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const refuse = terminalUnavailable(input.threadId);
        const where = yield* route(input.threadId, caller);
        if (where._tag === "local") return runLocal((yield* local).terminals);
        if (where._tag !== "remote") return Stream.fail(refuse(where));
        const resolved = terminalFolders(where, input);
        if (resolved === undefined) return Stream.fail(refuse(REFUSED));
        yield* remember(input, caller, where);
        return where.forward
          .stream("terminal.stream", {
            mode,
            root: where.remoteBase,
            input: resolved,
            ...(viewerId === undefined ? {} : { viewerId }),
          })
          .pipe(
            Stream.catchTags({
              EnvironmentExecutorUnavailableError: () =>
                Stream.fail(refuse({ _tag: "offline", name: where.name })),
            }),
            Stream.interruptWhen(untilUnusable(where.environmentId, caller)),
          );
      }),
    );

  return {
    searchEntries: (input: ProjectSearchEntriesInput, caller: WorkspaceCaller) =>
      routed(
        input,
        caller,
        (input) => Effect.flatMap(localCalls, (calls) => calls.searchEntries(input)),
        (forward, input, where) =>
          forward.call("search.paths", { root: where.remoteBase, input: withoutThread(input) }),
        (where) =>
          new ProjectSearchEntriesError({
            cwd: input.cwd,
            queryLength: input.query.length,
            limit: input.limit,
            ...entriesFailure(where),
          }),
      ),
    searchContents: (input: ProjectSearchContentsInput, caller: WorkspaceCaller) =>
      routed(
        input,
        caller,
        (input) => Effect.flatMap(localCalls, (calls) => calls.searchContents(input)),
        (forward, input, where) =>
          forward.call("search.contents", { root: where.remoteBase, input: withoutThread(input) }),
        (where) =>
          new ProjectSearchContentsError({
            cwd: input.cwd,
            queryLength: input.query.length,
            limit: input.limit,
            ...entriesFailure(where),
          }),
      ),
    listEntries: (input: ProjectListEntriesInput, caller: WorkspaceCaller) =>
      routed(
        input,
        caller,
        (input) => Effect.flatMap(localCalls, (calls) => calls.listEntries(input)),
        (forward, input, where) => {
          if (input.directoryPath === undefined || input.directoryPath === "") {
            return forward.call("entries.list", {
              root: where.remoteBase,
              input: withoutThread(input),
            });
          }
          const directoryPath = relativeInside(input.directoryPath);
          return directoryPath === undefined
            ? undefined
            : forward.call("entries.list", {
                root: where.remoteBase,
                input: { ...withoutThread(input), directoryPath },
              });
        },
        (where) => new ProjectListEntriesError({ cwd: input.cwd, ...entriesFailure(where) }),
      ),
    listIgnoredFiles: (input: ProjectListIgnoredFilesInput, caller: WorkspaceCaller) =>
      routed(
        input,
        caller,
        (input) => Effect.flatMap(localCalls, (calls) => calls.listIgnoredFiles(input)),
        (forward, input, where) =>
          forward.call("entries.listIgnored", {
            root: where.remoteBase,
            input: withoutThread(input),
          }),
        (where) => new ProjectListEntriesError({ cwd: input.cwd, ...entriesFailure(where) }),
      ),
    readFile: (input: ProjectReadFileInput, caller: WorkspaceCaller) =>
      routed(
        input,
        caller,
        (input) => Effect.flatMap(localCalls, (calls) => calls.readFile(input)),
        (forward, input, where) => {
          // An absolute path inside the workspace is sent relative to the root, never as is.
          const absolute = isAbsolute(input.relativePath);
          const relativePath = absolute
            ? onMachine(where, input.relativePath)
            : relativeInside(input.relativePath);
          return relativePath === undefined
            ? undefined
            : forward.call("files.read", {
                root: where.remoteBase,
                input: { ...withoutThread(input), ...(absolute ? { cwd: "." } : {}), relativePath },
              });
        },
        (where) => new ProjectReadFileError(fileFailure(where, input)),
      ),
    writeFile: (input: ProjectWriteFileInput, caller: WorkspaceCaller) =>
      routed(
        input,
        caller,
        (input) => Effect.flatMap(localCalls, (calls) => calls.writeFile(input)),
        (forward, input, where) => {
          // Only workspace-relative paths are writable, as on the Hub machine.
          const relativePath = relativeInside(input.relativePath);
          return relativePath === undefined
            ? undefined
            : forward.call("files.write", {
                root: where.remoteBase,
                input: { ...withoutThread(input), relativePath },
              });
        },
        (where) => new ProjectWriteFileError(fileFailure(where, input)),
      ),
    browse: Effect.fn("ThreadWorkspace.browse")(function* (
      input: FilesystemBrowseInput,
      caller: WorkspaceCaller,
    ) {
      const where = yield* route(input.threadId, caller);
      if (where._tag === "local") {
        return yield* Effect.flatMap(localCalls, (calls) => calls.browse(input));
      }
      const refuse = (route: Route) =>
        new FilesystemBrowseError({
          partialPath: input.partialPath,
          cwd: input.cwd,
          ...entriesFailure(route),
        });
      if (where._tag !== "remote") return yield* refuse(where);
      // On another machine only the Thread's own workspace can be browsed, relative to it.
      const cwd = onMachine(where, input.cwd ?? where.hubBase);
      if (
        cwd === undefined ||
        !isExplicitRelativePath(input.partialPath) ||
        relativeInside(input.partialPath) === undefined
      ) {
        return yield* refuse(REFUSED);
      }
      return yield* where.forward
        .call("entries.browse", {
          root: where.remoteBase,
          input: { partialPath: input.partialPath, cwd },
        })
        .pipe(
          Effect.catchTags({
            EnvironmentExecutorUnavailableError: () =>
              Effect.fail(refuse({ _tag: "offline", name: where.name })),
          }),
        );
    }),
    terminalOpen: (input: TerminalOpenInput, caller: WorkspaceCaller) =>
      terminalCall(
        input,
        caller,
        (terminals) => terminals.open(input),
        (forward, where) => {
          const resolved = terminalFolders(where, input);
          return resolved === undefined
            ? undefined
            : forward
                .call("terminal.open", { root: where.remoteBase, input: resolved })
                .pipe(Effect.tap(() => remember(input, caller, where)));
        },
      ),
    terminalWrite: (input: TerminalWriteInput, caller: WorkspaceCaller) =>
      openTerminalCall(
        input,
        caller,
        (terminals) => terminals.write(input),
        (forward) => forward.call("terminal.write", input),
      ),
    terminalResize: (
      input: TerminalResizeInput,
      viewerId: string | undefined,
      caller: WorkspaceCaller,
    ) =>
      openTerminalCall(
        input,
        caller,
        (terminals) => terminals.resize(input, viewerId),
        (forward) =>
          forward.call("terminal.resize", {
            input,
            ...(viewerId === undefined ? {} : { viewerId }),
          }),
      ),
    terminalClear: (input: TerminalClearInput, caller: WorkspaceCaller) =>
      openTerminalCall(
        input,
        caller,
        (terminals) => terminals.clear(input),
        (forward) => forward.call("terminal.clear", input),
      ),
    terminalClose: (input: TerminalCloseInput, caller: WorkspaceCaller) =>
      terminalCall(
        input,
        caller,
        (terminals) => terminals.close(input),
        (forward) => forward.call("terminal.close", input),
      ),
    terminalAttach: (input: TerminalAttachInput, viewerId: string, caller: WorkspaceCaller) =>
      terminalStream(input, caller, "attach", viewerId, (terminals) =>
        terminals.attachOutputStream(input, viewerId),
      ),
    terminalObserve: (input: TerminalObserveInput, caller: WorkspaceCaller) =>
      terminalStream(input, caller, "observe", undefined, (terminals) =>
        terminalOutputStream<TerminalAttachStreamEvent, TerminalError>(
          (listener, registerCleanup) => terminals.observeStream(input, listener, registerCleanup),
          (listener, registerCleanup) => terminals.resyncStream(input, listener, registerCleanup),
        ),
      ),
    previewOpen: (input: PreviewOpenInput, caller: WorkspaceCaller) =>
      previewCall(
        input.threadId,
        caller,
        (previews) => previews.open(input),
        (forward) => forward.call("preview.open", input),
      ),
    previewResize: (input: PreviewResizeInput, caller: WorkspaceCaller) =>
      previewCall(
        input.threadId,
        caller,
        (previews) => previews.resize(input),
        (forward) => forward.call("preview.resize", input),
      ),
    previewAdjust: (input: PreviewAdjustInput, caller: WorkspaceCaller) =>
      previewCall(
        input.threadId,
        caller,
        (previews) => previews.adjust(input),
        (forward) => forward.call("preview.adjust", input),
      ),
    previewClose: (input: PreviewCloseInput, caller: WorkspaceCaller) =>
      previewCall(
        input.threadId,
        caller,
        (previews) => previews.close(input),
        (forward) => forward.call("preview.close", input),
      ),
    /** No previews while the machine is offline: listing never fails. */
    previewList: (input: PreviewListInput, caller: WorkspaceCaller) =>
      previewCall(
        input.threadId,
        caller,
        (previews) => previews.list(input),
        (forward) => forward.call("preview.list", input),
      ).pipe(
        Effect.orElseSucceed((): PreviewListResult => ({
          sessions: [],
          serverEpoch: "environment-offline",
          revision: 0,
        })),
      ),
    previewReportStatus: (input: PreviewReportStatusInput, caller: WorkspaceCaller) =>
      previewCall(
        input.threadId,
        caller,
        (previews) => previews.reportStatus(input),
        (forward) => forward.call("preview.reportStatus", input),
      ),
    /** This machine's preview events and every connected Environment's, as they happen. */
    previewEvents: Stream.merge(
      Option.match(localRpc, { onNone: () => Stream.empty, onSome: (rpc) => rpc.previews.events }),
      Option.match(remoteEnvironments, {
        onNone: () => Stream.empty,
        onSome: (remote) => remote.previewEvents,
      }),
    ),
  };
});

export class ThreadWorkspace extends Context.Service<
  ThreadWorkspace,
  Effect.Success<typeof make>
>()("t3/environment/ThreadWorkspace") {}

/**
 * Over the executor registry, the projection and the Environments table where the host has them;
 * without them (hosts that run no Environments) every call answers on this machine.
 */
export const layer = Layer.effect(ThreadWorkspace, make);
