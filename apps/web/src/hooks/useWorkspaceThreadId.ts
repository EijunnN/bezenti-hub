import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useContext } from "react";

import { FileMetadataThreadContext } from "./FileMetadataThreadProvider";

/**
 * The Thread whose workspace a file, search or browse call is for, so the Hub runs it on that
 * Thread's Active environment. Undefined outside a Thread, or for another connection's files.
 */
export function useWorkspaceThreadId(environmentId: EnvironmentId | null): ThreadId | undefined {
  const threadRef = useContext(FileMetadataThreadContext);
  return threadRef !== null && threadRef.environmentId === environmentId
    ? threadRef.threadId
    : undefined;
}
