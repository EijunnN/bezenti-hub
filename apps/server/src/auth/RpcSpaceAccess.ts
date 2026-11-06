/**
 * How each RPC that reaches Projects or Threads keeps to what the session may see. Every
 * `orchestration.*` RPC and every RPC whose payload names a Thread or Project must be listed
 * (RpcAuthorization.test.ts checks). A refusal looks exactly like a missing one.
 */
import {
  ORCHESTRATION_V2_WS_METHODS,
  type ProjectId,
  SpaceActionDeniedError,
  SpaceResourceNotFoundError,
  type ThreadId,
  type UserId,
  WS_METHODS,
  type WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import type * as SpaceVisibility from "../spaces/SpaceVisibility.ts";

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

/**
 * `thread`/`project`: refuse ids the session cannot see. `command`: what it acts on, not what it
 * creates. `named`: Projects at any depth, no hidden Thread. `work`: the session User's own
 * Thread or held draft (`claimWork`). `owned`: every Thread named is the session User's own
 * (no drafts). `filtered`: the handler filters. `unscoped`: why not.
 */
export type RpcSpaceAccess =
  | "thread"
  | "project"
  | "command"
  | "named"
  | "work"
  | "owned"
  | "filtered"
  | { readonly unscoped: string };

const BY_DIRECTORY = { unscoped: "works on a directory, which filesystem scopes guard" };

export const RPC_SPACE_ACCESS = {
  // A hidden target answers like a missing one; the Role rules run on every command in the
  // orchestrator, whatever its transport.
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: "command",
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: "command",
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: "filtered",
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: "filtered",
  [ORCHESTRATION_V2_WS_METHODS.searchThreads]: "filtered",
  [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]: "filtered",
  [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]: "filtered",
  // The family is also read through SpaceVisibility, so a fork elsewhere stays hidden.
  [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.searchThread]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.getNativeChildWork]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: "thread",
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: "thread",
  [WS_METHODS.guestShareCreate]: "thread",
  [WS_METHODS.peerLinksAnswerRequest]: "thread",
  [WS_METHODS.secretsAnswerRequest]: "thread",
  [WS_METHODS.projectsCreateFromThread]: "thread",
  // An app acts inside its Thread's live session, so it is its creator's, like a message.
  [WS_METHODS.mcpAppsCallTool]: "owned",
  [WS_METHODS.mcpAppsToolInfo]: "thread",
  [WS_METHODS.mcpAppsReadResource]: "thread",
  [WS_METHODS.mcpAppsUpdateModelContext]: "owned",
  [WS_METHODS.providerUploadFeedback]: "thread",
  // Drafts use these before their Thread exists, so they also take a draft its User holds.
  [WS_METHODS.assetsPersistChatAttachments]: "work",
  [WS_METHODS.subscribeWorktreeSetup]: "work",
  [WS_METHODS.worktreeSetupCancel]: "work",
  [WS_METHODS.terminalOpen]: "work",
  [WS_METHODS.terminalAttach]: "work",
  [WS_METHODS.terminalObserve]: "work",
  [WS_METHODS.terminalWrite]: "work",
  [WS_METHODS.terminalResize]: "work",
  [WS_METHODS.terminalClear]: "work",
  [WS_METHODS.terminalClose]: "work",
  [WS_METHODS.previewOpen]: "work",
  [WS_METHODS.previewResize]: "work",
  [WS_METHODS.previewAdjust]: "work",
  [WS_METHODS.previewClose]: "work",
  [WS_METHODS.previewList]: "work",
  [WS_METHODS.previewReportStatus]: "work",
  [WS_METHODS.deviceOpen]: "work",
  [WS_METHODS.deviceClose]: "work",
  [WS_METHODS.gitRunStackedAction]: BY_DIRECTORY,
  [WS_METHODS.gitPreparePullRequestThread]: BY_DIRECTORY,
  [WS_METHODS.projectsMutate]: "command",
  [WS_METHODS.scheduledTasksUpsert]: {
    unscoped: "scheduled tasks run as the Owner until ticket 13",
  },
  [WS_METHODS.projectCloneStart]: { unscoped: "creates the Project it clones into" },
  [WS_METHODS.projectCloneCancel]: { unscoped: "a clone in progress has no Project row yet" },
  [WS_METHODS.projectCloneRetry]: { unscoped: "a clone in progress has no Project row yet" },
  [WS_METHODS.agentSessionsImport]: "project",
  [WS_METHODS.serverListAcpRegistrySessions]: "project",
  [WS_METHODS.serverImportAcpRegistrySession]: "project",
  [WS_METHODS.serverDeleteAcpRegistrySession]: "project",
  [WS_METHODS.serverListAcpRegistryProviders]: "project",
  [WS_METHODS.serverSetAcpRegistryProvider]: "project",
  [WS_METHODS.serverDisableAcpRegistryProvider]: "project",
  // Without a Project these name, the handler narrows them to the visible ones.
  [WS_METHODS.pullRequestsList]: "project",
  [WS_METHODS.pullRequestsListStats]: "project",
  [WS_METHODS.pullRequestsInvalidate]: "project",
  [WS_METHODS.pullRequestsReportState]: "project",
  [WS_METHODS.assetsCreateUrl]: "named",
  [WS_METHODS.serverReportClientActivity]: {
    unscoped: "reports this client's own activity and returns nothing",
  },
  [WS_METHODS.pullRequestsFilterOptions]: "project",
  [WS_METHODS.pullRequestsSummary]: "project",
  [WS_METHODS.pullRequestsRouting]: "project",
  [WS_METHODS.pullRequestsStack]: "project",
  // Also filtered: a Pull Request can link Threads in several Spaces.
  [WS_METHODS.pullRequestsLinkedThreads]: "project",
  [WS_METHODS.pullRequestsDetail]: "project",
  [WS_METHODS.pullRequestsPreview]: "project",
  [WS_METHODS.pullRequestsChecks]: "project",
  [WS_METHODS.pullRequestsActivity]: "project",
  [WS_METHODS.pullRequestsReviewGuide]: "project",
  [WS_METHODS.pullRequestsGenerateReviewGuide]: "project",
  [WS_METHODS.pullRequestsThreadComments]: "project",
  [WS_METHODS.pullRequestsDiffFileContents]: "project",
  [WS_METHODS.pullRequestsFilesViewed]: "project",
  [WS_METHODS.pullRequestsChangeBreakdown]: "project",
  [WS_METHODS.pullRequestsSetFilesViewed]: "project",
  [WS_METHODS.pullRequestsRunAction]: "project",
  [WS_METHODS.pullRequestsUpdate]: "project",
  [WS_METHODS.pullRequestsComment]: "project",
  [WS_METHODS.pullRequestsUpdateComment]: "project",
  [WS_METHODS.pullRequestsSubmitReview]: "project",
  [WS_METHODS.pullRequestsReplyToThread]: "project",
  [WS_METHODS.pullRequestsSetThreadResolution]: "project",
  [WS_METHODS.pullRequestsSetReaction]: "project",
  [WS_METHODS.pullRequestsReviewerCandidates]: "project",
  [WS_METHODS.pullRequestsRequestReviewers]: "project",
  [WS_METHODS.pullRequestsLabelCandidates]: "project",
  [WS_METHODS.pullRequestsSetLabels]: "project",
} as const satisfies Partial<Readonly<Record<WsRpcMethod, RpcSpaceAccess>>>;

export const spaceAccessForRpcMethod = (method: string): RpcSpaceAccess | undefined =>
  Object.hasOwn(RPC_SPACE_ACCESS, method)
    ? RPC_SPACE_ACCESS[method as keyof typeof RPC_SPACE_ACCESS]
    : undefined;

const notFound = () =>
  new SpaceResourceNotFoundError({ message: "That Project or Thread does not exist." });
const notYours = () =>
  new SpaceActionDeniedError({
    message: "Only the person who started this Thread can use its terminals, previews and files.",
  });

const THREAD_KEYS = new Set(["threadId", "threadIds", "conversationThreadId"]);
// A terminal runs in a folder the client names; it must be one the User may work in.
const DIRECTORY_FIELDS: Partial<Record<string, ReadonlyArray<string>>> = {
  [WS_METHODS.terminalOpen]: ["cwd", "worktreePath"],
  [WS_METHODS.terminalAttach]: ["cwd", "worktreePath"],
};
const PROJECT_KEYS = new Set(["projectId", "projectIds"]);

/** Every string under one of `keys`, at any depth of the payload. */
const idsUnder = (value: unknown, keys: ReadonlySet<string>, into: Array<string> = []) => {
  if (Array.isArray(value)) {
    for (const item of value) idsUnder(item, keys, into);
  } else if (Predicate.isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (keys.has(key)) {
        for (const id of Array.isArray(child) ? child : [child]) {
          if (typeof id === "string") into.push(id);
        }
      } else {
        idsUnder(child, keys, into);
      }
    }
  }
  return into;
};

const stringField = (payload: unknown, name: string): string | undefined => {
  const value = Predicate.isObject(payload)
    ? (payload as Record<string, unknown>)[name]
    : undefined;
  return typeof value === "string" ? value : undefined;
};

/**
 * What a command acts on, which must be visible, and what it creates, which must only not
 * belong to a Space the session cannot see.
 */
const commandTargets = (method: string, payload: unknown) => {
  const type = stringField(payload, "type");
  const created = new Set<string>();
  if (method === WS_METHODS.projectsMutate) {
    const projectId = stringField(payload, "projectId");
    return {
      threads: [],
      projects: type === "project.create" || projectId === undefined ? [] : [projectId],
      created: [],
    };
  }
  // A launch's client-chosen id that names a hidden Thread is handled by ThreadLaunchService,
  // which answers it like an unused id.
  if (method === ORCHESTRATION_V2_WS_METHODS.launchThread) {
    const projectId = stringField(payload, "projectId");
    return { threads: [], projects: projectId === undefined ? [] : [projectId], created: [] };
  }
  const createdField =
    type === "thread.create"
      ? "threadId"
      : type === "thread.fork" || type === "thread.created.record"
        ? "targetThreadId"
        : undefined;
  const threads: Array<string> = [];
  for (const field of [
    "threadId",
    "sourceThreadId",
    "targetThreadId",
    "parentThreadId",
    "senderThreadId",
  ]) {
    const id = stringField(payload, field);
    if (id === undefined) continue;
    if (field === createdField) created.add(id);
    else threads.push(id);
  }
  const projectId = stringField(payload, "projectId");
  return { threads, projects: projectId === undefined ? [] : [projectId], created: [...created] };
};

/**
 * Refuses the call when the payload names a Project or Thread the viewer may not see. A
 * missing one is refused the same way, so neither answer is an existence oracle.
 */
export const guardRpcPayload = Effect.fn("RpcSpaceAccess.guardRpcPayload")(function* (
  method: string,
  payload: unknown,
  visibility: SpaceVisibility.Visibility,
  spaceVisibility: SpaceVisibility.SpaceVisibility["Service"],
  userId: UserId | undefined,
) {
  const access = spaceAccessForRpcMethod(method);
  // Before the Owner's early return: the Owner's drafts are held too, so no one else works them.
  if (access === "work") {
    const threadId = stringField(payload, "threadId");
    if (threadId === undefined) return yield* notFound();
    const work = yield* spaceVisibility.claimWork(visibility, userId, threadId);
    if (work === "hidden") return yield* notFound();
    if (work === "not-yours") return yield* notYours();
    for (const field of DIRECTORY_FIELDS[method] ?? []) {
      const directory = stringField(payload, field);
      if (
        directory !== undefined &&
        !(yield* spaceVisibility.mayUseDirectory(visibility, userId, directory))
      ) {
        return yield* new SpaceActionDeniedError({
          message:
            "You can only open terminals in your own Threads' folders and your team's Projects.",
        });
      }
    }
    return;
  }
  if (access === "owned") {
    const threads = idsUnder(payload, THREAD_KEYS);
    if (threads.length === 0) return yield* notFound();
    for (const threadId of threads) {
      const work = yield* spaceVisibility.claimWork(visibility, userId, threadId, {
        drafts: false,
      });
      if (work === "hidden") return yield* notFound();
      if (work === "not-yours") {
        return yield* new SpaceActionDeniedError({
          message:
            "Only the person who started this Thread can continue it. Start a new Thread to build on it.",
        });
      }
    }
    return;
  }
  if (visibility.all) return;
  const requireVisible = Effect.fn(function* (
    threads: ReadonlyArray<string>,
    projects: ReadonlyArray<string>,
  ) {
    const [visibleThreads, visibleProjects] = yield* Effect.all([
      spaceVisibility.visibleThreadIds(visibility, threads as ReadonlyArray<ThreadId>),
      spaceVisibility.visibleProjectIds(visibility, projects as ReadonlyArray<ProjectId>),
    ]);
    if (
      threads.some((id) => !visibleThreads.has(id as ThreadId)) ||
      projects.some((id) => !visibleProjects.has(id as ProjectId))
    ) {
      return yield* notFound();
    }
  });
  if (access === "thread") {
    const threads = idsUnder(payload, THREAD_KEYS);
    if (stringField(payload, "threadId") === undefined) return yield* notFound();
    return yield* requireVisible(threads, idsUnder(payload, PROJECT_KEYS));
  }
  if (access === "project") return yield* requireVisible([], idsUnder(payload, PROJECT_KEYS));
  if (access === "named") {
    yield* requireVisible([], idsUnder(payload, PROJECT_KEYS));
    const hidden = yield* spaceVisibility.hiddenThreadIds(
      visibility,
      idsUnder(payload, THREAD_KEYS),
    );
    if (hidden.size > 0) return yield* notFound();
    return;
  }
  if (access === "command") {
    const targets = commandTargets(method, payload);
    yield* requireVisible(targets.threads, targets.projects);
    // A new id that names a hidden Thread answers like any hidden Thread.
    const hidden = yield* spaceVisibility.hiddenThreadIds(visibility, targets.created);
    if (hidden.size > 0) return yield* notFound();
  }
});
