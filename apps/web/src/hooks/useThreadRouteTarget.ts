import type { ScopedThreadRef } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";

import {
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "../threadRoutes";
import { useHubEnvironmentId } from "../state/hubEnvironment";

function useThreadRouteIds() {
  const environmentId = useParams({ strict: false, select: (params) => params.environmentId });
  const threadId = useParams({ strict: false, select: (params) => params.threadId });
  return { environmentId, threadId };
}

export function useThreadRouteTarget(): ThreadRouteTarget | null {
  const { environmentId, threadId } = useThreadRouteIds();
  const draftId = useParams({ strict: false, select: (params) => params.draftId });
  const hubEnvironmentId = useHubEnvironmentId();
  return resolveThreadRouteTarget({ environmentId, threadId, draftId }, hubEnvironmentId);
}

export function useThreadRouteRef(): ScopedThreadRef | null {
  return resolveThreadRouteRef(useThreadRouteIds(), useHubEnvironmentId());
}
