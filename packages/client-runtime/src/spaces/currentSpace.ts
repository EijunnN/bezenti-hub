import type { EnvironmentId, SpaceId } from "@t3tools/contracts";

// The client's current Space per environment. New Projects and Threads are sent with it; the
// server checks it and falls back to the User's Personal space when none is set.
const currentSpaces = new Map<string, SpaceId>();

export function setCurrentSpace(environmentId: EnvironmentId, spaceId: SpaceId | null): void {
  if (spaceId === null) currentSpaces.delete(environmentId);
  else currentSpaces.set(environmentId, spaceId);
}

export function currentSpaceFor(environmentId: string): SpaceId | undefined {
  return currentSpaces.get(environmentId);
}
