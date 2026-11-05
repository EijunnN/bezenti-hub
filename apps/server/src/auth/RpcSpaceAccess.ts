/**
 * How each RPC that reaches Projects or Threads keeps to what the session may see. Every
 * `orchestration.*` RPC and every RPC whose payload names a Thread or Project must be listed
 * (RpcAuthorization.test.ts checks). A refusal looks exactly like a missing one.
 */
import {
  ORCHESTRATION_V2_WS_METHODS,
  type ProjectId,
  SpaceResourceNotFoundError,
  type ThreadId,
  WS_METHODS,
  type WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import type * as SpaceVisibility from "../spaces/SpaceVisibility.ts";

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

/**
 * `thread` and `project`: the middleware refuses ids the session cannot see. `filtered`: the
 * handler reads through SpaceVisibility. `unscoped`: why the rule does not apply here.
 */
export type RpcSpaceAccess = "thread" | "project" | "filtered" | { readonly unscoped: string };

const WRITE_RULES = { unscoped: "a write: ticket 08 asks AccessPolicy before dispatch" };
const DRAFTS = {
  unscoped: "drafts use it before their Thread exists; ticket 08 sets the operate rules",
};
const BY_DIRECTORY = { unscoped: "works on a directory, which filesystem scopes guard" };

export const RPC_SPACE_ACCESS = {
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: WRITE_RULES,
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: {
    unscoped: "creates a Thread; SpaceDirectory.claimCreation checks its Space",
  },
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
  [WS_METHODS.mcpAppsCallTool]: "thread",
  [WS_METHODS.mcpAppsToolInfo]: "thread",
  [WS_METHODS.mcpAppsReadResource]: "thread",
  [WS_METHODS.mcpAppsUpdateModelContext]: "thread",
  [WS_METHODS.providerUploadFeedback]: "thread",
  [WS_METHODS.assetsPersistChatAttachments]: DRAFTS,
  [WS_METHODS.subscribeWorktreeSetup]: {
    unscoped: "starts while the Thread it sets up is still launching; ticket 08",
  },
  [WS_METHODS.worktreeSetupCancel]: {
    unscoped: "starts while the Thread it sets up is still launching; ticket 08",
  },
  [WS_METHODS.terminalOpen]: DRAFTS,
  [WS_METHODS.terminalAttach]: DRAFTS,
  [WS_METHODS.terminalObserve]: DRAFTS,
  [WS_METHODS.terminalWrite]: DRAFTS,
  [WS_METHODS.terminalResize]: DRAFTS,
  [WS_METHODS.terminalClear]: DRAFTS,
  [WS_METHODS.terminalClose]: DRAFTS,
  [WS_METHODS.previewOpen]: DRAFTS,
  [WS_METHODS.previewResize]: DRAFTS,
  [WS_METHODS.previewAdjust]: DRAFTS,
  [WS_METHODS.previewClose]: DRAFTS,
  [WS_METHODS.previewList]: DRAFTS,
  [WS_METHODS.previewReportStatus]: DRAFTS,
  [WS_METHODS.deviceOpen]: DRAFTS,
  [WS_METHODS.deviceClose]: DRAFTS,
  [WS_METHODS.gitRunStackedAction]: BY_DIRECTORY,
  [WS_METHODS.gitPreparePullRequestThread]: BY_DIRECTORY,
  [WS_METHODS.projectsMutate]: WRITE_RULES,
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
  [WS_METHODS.pullRequestsList]: "project",
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

const field = (payload: unknown, name: string): unknown =>
  Predicate.isObject(payload) && name in payload
    ? (payload as Record<string, unknown>)[name]
    : undefined;

/**
 * Refuses the call when the payload names a Project or Thread the viewer may not see. A
 * missing one is refused the same way, so neither answer is an existence oracle.
 */
export const guardRpcPayload = Effect.fn("RpcSpaceAccess.guardRpcPayload")(function* (
  method: string,
  payload: unknown,
  visibility: SpaceVisibility.Visibility,
  spaceVisibility: SpaceVisibility.SpaceVisibility["Service"],
) {
  if (visibility.all) return;
  const access = spaceAccessForRpcMethod(method);
  if (access === "thread") {
    const threadId = field(payload, "threadId");
    if (typeof threadId !== "string") return yield* notFound();
    const visible = yield* spaceVisibility.visibleThreadIds(visibility, [threadId as ThreadId]);
    if (!visible.has(threadId as ThreadId)) return yield* notFound();
    return;
  }
  if (access === "project") {
    const single = field(payload, "projectId");
    const many = field(payload, "projectIds");
    const projectIds: Array<ProjectId> = [];
    if (typeof single === "string") projectIds.push(single as ProjectId);
    if (Array.isArray(many)) {
      for (const id of many) if (typeof id === "string") projectIds.push(id as ProjectId);
    }
    if (projectIds.length === 0) return;
    const visible = yield* spaceVisibility.visibleProjectIds(visibility, projectIds);
    if (projectIds.some((projectId) => !visible.has(projectId))) return yield* notFound();
  }
});
