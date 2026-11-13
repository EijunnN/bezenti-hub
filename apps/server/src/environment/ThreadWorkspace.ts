/**
 * Where workspace RPCs (files, search, browse, terminals, previews) run: one naming a Thread on its
 * Active environment, inside its workspace there; one naming none on the Hub machine. The machine
 * comes from the Thread, never from a client path (`docs/internals/overview.md`, «Workspace RPCs»).
 */
import {
  FilesystemBrowseError,
  type FilesystemBrowseInput,
  ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  type EnvironmentId,
  NO_SECRETS_FINGERPRINT,
  SECRET_ENV_CONTRACT_VERSION,
  type SecretEnv,
  HUB_MACHINE_ENVIRONMENT_ID,
  HUB_RUNS_NO_AGENTS_MESSAGE,
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
import * as Schema from "effect/Schema";
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
import * as EnvironmentDemand from "./EnvironmentDemand.ts";
import * as EnvironmentExecutor from "./EnvironmentExecutor.ts";
import * as HubRunsAgents from "./HubRunsAgents.ts";
import * as ProjectCheckouts from "./ProjectCheckouts.ts";
import * as RemoteEnvironments from "./RemoteEnvironments.ts";
import { locateInCheckout } from "./WorkspaceLocation.ts";
import * as SecretDelivery from "../vaults/SecretDelivery.ts";
import * as SecretMasker from "../vaults/SecretMasker.ts";
import { maskTerminalSnapshot, maskTerminalStream } from "../vaults/maskTerminal.ts";

/** Who asks: the session's User, whose rules a forwarded call keeps to. */
export interface WorkspaceCaller {
  readonly userId: UserId | undefined;
  /**
   * The User acts (opens a terminal, types, writes a file, opens a preview): a stopped Sandbox
   * starts for it. Reads and listings never start one, nor count as use.
   */
  readonly startsSandbox?: boolean;
}

/** The same caller, acting: a stopped Sandbox starts for the call. */
const acting = (caller: WorkspaceCaller): WorkspaceCaller => ({ ...caller, startsSandbox: true });

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
  | {
      readonly _tag: "offline";
      readonly name: string | undefined;
      /** A Sandbox that is not running, which a read does not start. */
      readonly stopped?: boolean;
    }
  | { readonly _tag: "refused" }
  /** An action (a terminal, a write) the Hub machine would run, and it runs no agents. */
  | { readonly _tag: "hub-off" };

const LOCAL: Route = { _tag: "local" };
const HUB_OFF: Route = { _tag: "hub-off" };
const REFUSED: Route = { _tag: "refused" };

const offlineMessage = (name: string | undefined, stopped = false) =>
  stopped
    ? `Sandbox stopped: ${name ?? "the Sandbox"} starts when you send a message or open a terminal.`
    : name === undefined
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

const isTerminalUnavailable = Schema.is(TerminalEnvironmentUnavailableError);
/** An attach without a folder found no shell to reattach (as the machine says it, old or new). */
const noShellToReattach = (error: TerminalError) =>
  error._tag === "TerminalSessionLookupError" ||
  (isTerminalUnavailable(error) && error.reason === "outside_thread_workspace");

export const make = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(EnvironmentExecutor.EnvironmentExecutorRegistry);
  const projections = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
  const checkouts = yield* Effect.serviceOption(ProjectCheckouts.ProjectCheckouts);
  const environments = yield* Effect.serviceOption(EnvironmentRegistry.EnvironmentRegistry);
  const remoteEnvironments = yield* Effect.serviceOption(RemoteEnvironments.RemoteEnvironments);
  // Sandboxes start for these calls and count them, and open terminals, as activity.
  const demand = yield* Effect.serviceOption(EnvironmentDemand.EnvironmentDemand);
  const runsAgents = yield* HubRunsAgents.HubRunsAgents;
  // Spec 5 ticket 04: a shell gets the secrets of the User who opens it, read as it opens.
  const secretDelivery = yield* Effect.serviceOption(SecretDelivery.SecretDelivery);
  // Spec 5 ticket 05: and what comes back from the Thread's machine is masked.
  const secretMasker = yield* Effect.serviceOption(SecretMasker.SecretMasker);
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
    // The Hub machine's services answer reads of the Hub's own copy (listings, search, reading
    // files, browsing folders), which run no code; with no agents on it, nothing that acts.
    const local = runsAgents || caller.startsSandbox !== true ? LOCAL : HUB_OFF;
    if (
      threadId === undefined ||
      Option.isNone(registry) ||
      Option.isNone(projections) ||
      Option.isNone(checkouts) ||
      Option.isNone(environments)
    ) {
      return local;
    }
    const environmentId = yield* registry.value.activeEnvironment(ThreadId.make(threadId));
    // A draft, or a Thread on the Hub machine: the Hub machine's services answer, as before.
    if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) return local;
    if (environmentId === EnvironmentExecutor.NO_ENVIRONMENT_ID) {
      // A draft (not placed yet) on a Hub that runs no agents: as a call without a Thread.
      if (
        !runsAgents &&
        Option.isNone(yield* Effect.option(projections.value.getThread(ThreadId.make(threadId))))
      ) {
        return local;
      }
      return { _tag: "offline", name: undefined } satisfies Route;
    }
    const usable = yield* environments.value
      .usableBy({ userId: caller.userId, environmentId, threadId: ThreadId.make(threadId) })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(usable)) return REFUSED;
    const name = usable.value.name;
    const offline: Route = { _tag: "offline", name };
    if (Option.isSome(demand)) {
      // A User's action starts a stopped Sandbox and waits; a read answers at once, untouched.
      if (caller.startsSandbox !== true) {
        if (!(yield* demand.value.ready(environmentId))) {
          return { _tag: "offline", name, stopped: true } satisfies Route;
        }
      } else {
        const started = yield* demand.value
          .awaitStarted(environmentId, { actorUserId: caller.userId, explicit: true })
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("A Sandbox did not start for a workspace call", {
                environmentId,
                detail: error.detail,
              }).pipe(Effect.as(false)),
            ),
          );
        if (!started) return offline;
      }
    }
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
    route._tag === "hub-off"
      ? {
          cwd: input.cwd,
          relativePath: input.relativePath,
          failure: "hub_runs_no_agents" as const,
          message: HUB_RUNS_NO_AGENTS_MESSAGE,
        }
      : route._tag === "offline"
        ? {
            cwd: input.cwd,
            relativePath: input.relativePath,
            failure: "environment_offline" as const,
            message: offlineMessage(route.name, route.stopped),
          }
        : {
            cwd: input.cwd,
            relativePath: input.relativePath,
            failure: "workspace_path_outside_root" as const,
            message: REFUSED_MESSAGE,
          };

  const entriesFailure = (route: Route) =>
    route._tag === "hub-off"
      ? { failure: "environment_offline" as const, message: HUB_RUNS_NO_AGENTS_MESSAGE }
      : route._tag === "offline"
        ? {
            failure: "environment_offline" as const,
            message: offlineMessage(route.name, route.stopped),
          }
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
        reason:
          route._tag === "hub-off"
            ? "hub_runs_no_agents"
            : route._tag === "offline"
              ? "environment_offline"
              : "outside_thread_workspace",
        ...(route._tag === "offline" && route.name !== undefined
          ? { environmentName: route.name }
          : {}),
      });

  const previewUnavailable =
    (threadId: string) =>
    (route: Route): PreviewError =>
      new PreviewEnvironmentUnavailableError({
        threadId,
        reason:
          route._tag === "hub-off"
            ? "hub_runs_no_agents"
            : route._tag === "offline"
              ? "environment_offline"
              : "outside_thread_workspace",
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

  type Target = { readonly environmentId: EnvironmentId; readonly contractVersion: number };
  const secretsUnavailable = (threadId: string) => (error: { readonly message: string }) =>
    new TerminalEnvironmentUnavailableError({
      threadId,
      reason: "secrets_unavailable",
      detail: error.message,
    });
  /** Which secrets the caller's shells of the Thread on `target` get now: no value is read. */
  const terminalPlan = (
    threadId: string,
    caller: WorkspaceCaller,
    target: Target,
  ): Effect.Effect<SecretDelivery.SecretPlan | undefined, TerminalError> =>
    Option.isNone(secretDelivery)
      ? Effect.succeed(undefined)
      : secretDelivery.value
          .plan({ threadId: ThreadId.make(threadId), actingUserId: caller.userId, target })
          .pipe(Effect.mapError(secretsUnavailable(threadId)));
  /** The set's name only; an empty set is said explicitly, so a shell that had secrets is stale. */
  const currentSecrets = (plan: SecretDelivery.SecretPlan): SecretEnv =>
    plan.variables.length === 0
      ? { fingerprint: NO_SECRETS_FINGERPRINT, variables: [] }
      : { fingerprint: plan.fingerprint };
  const isSecretsRequired = (error: unknown) =>
    isTerminalUnavailable(error) && error.reason === "secrets_required";
  /**
   * Calls with the set's name; the machine answers `secrets_required` only when a shell would
   * start, and then the values are read and sent. A reattach to a running shell reads none.
   */
  const withTerminalSecrets = <A, E>(
    threadId: string,
    plan: SecretDelivery.SecretPlan | undefined,
    call: (secrets: SecretEnv | undefined) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | TerminalError> =>
    plan === undefined || Option.isNone(secretDelivery)
      ? call(undefined)
      : call(currentSecrets(plan)).pipe(
          Effect.catchIf(isSecretsRequired, () =>
            secretDelivery.value
              .resolve(plan)
              .pipe(Effect.mapError(secretsUnavailable(threadId)), Effect.flatMap(call)),
          ),
        );
  /** A machine before contract 10 gets no `secretEnv`: only an empty set, or a refusal. */
  const outdatedWith = (target: Target, plan: SecretDelivery.SecretPlan | undefined) =>
    target.contractVersion < SECRET_ENV_CONTRACT_VERSION &&
    plan !== undefined &&
    plan.variables.length > 0;
  const LOCAL_TARGET = {
    environmentId: HUB_MACHINE_ENVIRONMENT_ID,
    contractVersion: ENVIRONMENT_EXECUTOR_CONTRACT_VERSION,
  };
  const remoteTarget = (where: Extract<Route, { _tag: "remote" }>) => ({
    environmentId: where.environmentId,
    contractVersion: where.forward.contractVersion(),
  });

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
          if (Option.isSome(demand) && caller.startsSandbox === true) {
            yield* demand.value.touch(known.environmentId);
          }
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
  const untilUnusable = (
    environmentId: EnvironmentId,
    caller: WorkspaceCaller,
    threadId: string,
  ) =>
    Option.isNone(registry) || Option.isNone(environments)
      ? Effect.never
      : Effect.scoped(
          Effect.gen(function* () {
            const changes = yield* registry.value.changes;
            while (true) {
              yield* PubSub.take(changes);
              const usable = yield* environments.value
                .usableBy({
                  userId: caller.userId,
                  environmentId,
                  threadId: ThreadId.make(threadId),
                })
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
      secrets: TerminalManager.TerminalSecrets | undefined,
    ) => Stream.Stream<TerminalAttachStreamEvent, TerminalError>,
  ): Stream.Stream<TerminalAttachStreamEvent, TerminalError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const refuse = terminalUnavailable(input.threadId);
        const where = yield* route(input.threadId, caller);
        // Spec 5: an attach may start the shell (a new terminal), with the caller's secrets.
        const attach = mode === "attach";
        /** Opens with the set's name; again with the values if a shell would start. */
        const withSecrets = (
          plan: SecretDelivery.SecretPlan | undefined,
          open: (
            secrets: SecretEnv | undefined,
          ) => Stream.Stream<TerminalAttachStreamEvent, TerminalError>,
        ): Stream.Stream<TerminalAttachStreamEvent, TerminalError> =>
          plan === undefined || Option.isNone(secretDelivery)
            ? open(undefined)
            : open(currentSecrets(plan)).pipe(
                Stream.catchIf(isSecretsRequired, () =>
                  Stream.unwrap(
                    secretDelivery.value
                      .resolve(plan)
                      .pipe(Effect.mapError(secretsUnavailable(input.threadId)), Effect.map(open)),
                  ),
                ),
              );
        if (where._tag === "local") {
          const plan = attach
            ? yield* terminalPlan(input.threadId, caller, LOCAL_TARGET)
            : undefined;
          const terminals = (yield* local).terminals;
          return withSecrets(plan, (secrets) => runLocal(terminals, secrets));
        }
        if (where._tag !== "remote") return Stream.fail(refuse(where));
        const target = remoteTarget(where);
        const plan = attach ? yield* terminalPlan(input.threadId, caller, target) : undefined;
        const outdated = outdatedWith(target, plan);
        // A machine too old for secrets only reattaches a running shell: nothing that starts one.
        const { cwd: _cwd, restartIfNotRunning: _restart, ...attachOnly } = input;
        const resolved = terminalFolders(where, outdated ? attachOnly : input);
        if (resolved === undefined) return Stream.fail(refuse(REFUSED));
        yield* remember(input, caller, where);
        // An open terminal keeps its Sandbox from idling, for as long as the stream lives.
        if (Option.isSome(demand)) yield* demand.value.hold(where.environmentId);
        const open = (secrets: SecretEnv | undefined) =>
          where.forward
            .stream("terminal.stream", {
              mode,
              root: where.remoteBase,
              input: resolved,
              ...(viewerId === undefined ? {} : { viewerId }),
              ...(secrets === undefined ? {} : { secretEnv: secrets }),
            })
            .pipe(
              Stream.catchTags({
                EnvironmentExecutorUnavailableError: () =>
                  Stream.fail(refuse({ _tag: "offline", name: where.name })),
              }),
              Stream.interruptWhen(untilUnusable(where.environmentId, caller, input.threadId)),
            );
        if (outdated && plan !== undefined && Option.isSome(secretDelivery)) {
          const delivery = secretDelivery.value;
          // No running shell to reattach: say why it does not start (the machine needs an update).
          return open(undefined).pipe(
            Stream.catchIf(noShellToReattach, () =>
              Stream.fromEffect(
                delivery
                  .resolve(plan)
                  .pipe(
                    Effect.mapError(secretsUnavailable(input.threadId)),
                    Effect.andThen(Effect.fail(refuse(REFUSED))),
                  ),
              ),
            ),
          );
        }
        return withSecrets(
          target.contractVersion < SECRET_ENV_CONTRACT_VERSION ? undefined : plan,
          open,
        );
      }),
    );

  const calls = {
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
        acting(caller),
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
        acting(caller),
        // Spec 5: the shell gets the opening User's secrets.
        (terminals) =>
          terminalPlan(input.threadId, caller, LOCAL_TARGET).pipe(
            Effect.flatMap((plan) =>
              withTerminalSecrets(input.threadId, plan, (secrets) =>
                terminals.open(input, secrets),
              ),
            ),
          ),
        (forward, where) => {
          const resolved = terminalFolders(where, input);
          const target = remoteTarget(where);
          return resolved === undefined
            ? undefined
            : terminalPlan(input.threadId, caller, target).pipe(
                Effect.flatMap((plan) => {
                  const open = (secrets: SecretEnv | undefined) =>
                    forward.call("terminal.open", {
                      root: where.remoteBase,
                      input: resolved,
                      ...(secrets === undefined ? {} : { secretEnv: secrets }),
                    });
                  // A machine too old for secrets: an empty set works as before, else it says why.
                  if (target.contractVersion < SECRET_ENV_CONTRACT_VERSION) {
                    return outdatedWith(target, plan) &&
                      plan !== undefined &&
                      Option.isSome(secretDelivery)
                      ? secretDelivery.value.resolve(plan).pipe(
                          Effect.mapError(secretsUnavailable(input.threadId)),
                          Effect.flatMap(() => open(undefined)),
                        )
                      : open(undefined);
                  }
                  return withTerminalSecrets(input.threadId, plan, open);
                }),
                Effect.tap(() => remember(input, caller, where)),
              );
        },
      ),
    terminalWrite: (input: TerminalWriteInput, caller: WorkspaceCaller) =>
      openTerminalCall(
        input,
        acting(caller),
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
      terminalStream(input, acting(caller), "attach", viewerId, (terminals, secrets) =>
        terminals.attachOutputStream(input, viewerId, secrets),
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
        acting(caller),
        // A server tab a person opens browses in that person's profile (PreviewProfiles).
        (previews) =>
          previews.open(
            caller.userId === undefined ? input : { ...input, openedBy: caller.userId },
          ),
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

  // Spec 5 ticket 05: what a machine answers about a Thread's files and terminals reaches a client
  // masked, on the Hub machine and on any other. Search drops a match on a line holding a value:
  // searching for parts of it would otherwise tell it, a character at a time.
  if (Option.isNone(secretMasker)) return calls;
  const masker = secretMasker.value;
  const maskerOf = (threadId: string | undefined) => masker.forThread(threadId);
  return {
    ...calls,
    readFile: (input: ProjectReadFileInput, caller: WorkspaceCaller) =>
      calls.readFile(input, caller).pipe(
        Effect.flatMap((result) =>
          Effect.map(maskerOf(input.threadId), (threadMasker) => {
            const contents = threadMasker.mask(result.contents);
            return contents === result.contents ? result : { ...result, contents };
          }),
        ),
      ),
    searchContents: (input: ProjectSearchContentsInput, caller: WorkspaceCaller) =>
      calls.searchContents(input, caller).pipe(
        Effect.flatMap((result) =>
          Effect.map(maskerOf(input.threadId), (threadMasker) =>
            threadMasker.isEmpty
              ? result
              : {
                  ...result,
                  matches: result.matches.filter(
                    (match) => !threadMasker.matches(match.lineContent),
                  ),
                },
          ),
        ),
      ),
    terminalOpen: (input: TerminalOpenInput, caller: WorkspaceCaller) =>
      calls
        .terminalOpen(input, caller)
        .pipe(
          Effect.flatMap((snapshot) =>
            Effect.map(maskerOf(input.threadId), (threadMasker) =>
              maskTerminalSnapshot(threadMasker, snapshot),
            ),
          ),
        ),
    terminalAttach: (input: TerminalAttachInput, viewerId: string, caller: WorkspaceCaller) =>
      maskTerminalStream(masker, input.threadId, calls.terminalAttach(input, viewerId, caller)),
    terminalObserve: (input: TerminalObserveInput, caller: WorkspaceCaller) =>
      maskTerminalStream(masker, input.threadId, calls.terminalObserve(input, caller)),
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
