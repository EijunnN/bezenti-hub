import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useActiveEnvironment, useHasJoinedEnvironments } from "../../state/hubEnvironments";
import {
  type ThreadEnvironmentPresentation,
  threadEnvironmentPresentation,
} from "./threadEnvironmentText";

/** Where `thread` runs and its machine's live status, for its row and header; null for no news. */
export function useThreadEnvironment(
  thread: Pick<EnvironmentThreadShell, "activeEnvironmentId" | "runtime"> | null,
): ThreadEnvironmentPresentation | null {
  const environment = useActiveEnvironment(
    thread === null ? undefined : thread.activeEnvironmentId,
  );
  const hasJoinedEnvironments = useHasJoinedEnvironments();
  if (thread === null) return null;
  return threadEnvironmentPresentation({
    environment,
    hasJoinedEnvironments,
    turnUnderWay: threadRuntimeIsActive(thread.runtime),
  });
}
