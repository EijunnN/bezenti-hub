import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { DraftId } from "./composerDraftStore";
import { readHubEnvironmentId } from "./state/hubEnvironment";

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

type DraftThreadRouteState = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  promotedTo?: ScopedThreadRef | null;
};

export type ThreadRouteRenderState = "loading" | "ready" | "missing";

export function isThreadRouteSnapshotAuthoritative(
  status: EnvironmentShellStatus | null | undefined,
): boolean {
  return status === "live";
}

export function resolveThreadRouteRenderState(input: {
  bootstrapComplete: boolean;
  serverThreadExists: boolean;
  serverThreadDeleted: boolean;
  unlistedThreadDetail: EnvironmentThreadState;
  draftThreadExists: boolean;
}): ThreadRouteRenderState {
  if (input.draftThreadExists || (input.serverThreadExists && !input.serverThreadDeleted)) {
    return "ready";
  }
  if (!input.bootstrapComplete) {
    return "loading";
  }
  if (input.serverThreadExists || input.unlistedThreadDetail.status === "deleted") {
    return "missing";
  }
  // Shell membership can lag a new thread; its detail decides.
  const projection = Option.getOrNull(input.unlistedThreadDetail.data);
  if (projection === null) {
    return "loading";
  }
  return projection.thread.deletedAt !== null || projection.thread.archivedAt !== null
    ? "missing"
    : "ready";
}

/**
 * A Thread's route is `/$threadId`. The client has one connection, the Hub's, so the Thread's id
 * alone names it, and the URL stays the same when the Thread moves to another Environment.
 */
export function buildThreadRouteParams(ref: ScopedThreadRef): { threadId: ThreadId } {
  return { threadId: ref.threadId };
}

/** Whether a (decoded) location pathname is `ref`'s own thread route, `/$threadId`. */
export function isThreadRoutePathname(pathname: string, ref: ScopedThreadRef): boolean {
  return pathname.replace(/\/$/, "") === `/${ref.threadId}`;
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

/**
 * The route's Thread, on the Hub connection: `hubEnvironmentId` is that connection's id, unknown
 * until it is first reached. A route that still names an environment (the old links) keeps it.
 */
export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
  hubEnvironmentId: EnvironmentId | null = readHubEnvironmentId(),
): ScopedThreadRef | null {
  const environmentId = params.environmentId ?? hubEnvironmentId;
  if (!environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
  hubEnvironmentId: EnvironmentId | null = readHubEnvironmentId(),
): ThreadRouteTarget | null {
  const threadRef = resolveThreadRouteRef(params, hubEnvironmentId);
  if (threadRef !== null) {
    return { kind: "server", threadRef };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}

export function resolveActiveThreadRouteRef(
  target: ThreadRouteTarget | null,
  draftThread: DraftThreadRouteState | null,
): ScopedThreadRef | null {
  if (target?.kind === "server") {
    return target.threadRef;
  }
  if (target?.kind !== "draft" || !draftThread?.promotedTo) {
    return null;
  }
  return draftThread.promotedTo;
}
