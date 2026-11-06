import type { OrchestrationV2Subagent, OrchestrationV2TurnItem } from "@t3tools/contracts";

import { threadHasUnfinishedWork } from "./Orchestrator.ts";

/** What `threadHasLiveWork` reads, as `getThreadRecords` fields and filter. */
export const LIVE_WORK_FIELDS = ["runs", "runtimeRequests", "turnItems", "subagents"] as const;
export const LIVE_WORK_FILTER = {
  turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
  turnItemStatuses: ["pending", "running", "waiting"],
} as const;

/**
 * Whether anything still runs in the Thread: an unfinished run or open request, as for moving it,
 * and also background commands or delegated tasks that outlive a completed turn, which Stop ends.
 */
export function threadHasLiveWork(records: {
  readonly runs: ReadonlyArray<{ readonly status: string }>;
  readonly runtimeRequests: ReadonlyArray<{ readonly status: string }>;
  readonly turnItems: ReadonlyArray<Pick<OrchestrationV2TurnItem, "type" | "status">>;
  readonly subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status">>;
}): boolean {
  const active = (status: string) =>
    status === "pending" || status === "running" || status === "waiting";
  return (
    threadHasUnfinishedWork(records) ||
    records.turnItems.some(
      (item) =>
        (item.type === "command_execution" ||
          item.type === "dynamic_tool" ||
          item.type === "subagent") &&
        active(item.status),
    ) ||
    records.subagents.some((task) => active(task.status))
  );
}
