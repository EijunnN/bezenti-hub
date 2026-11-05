import type { EnvironmentId, SpaceDirectoryView, SpaceId } from "@t3tools/contracts";
import { setCurrentSpace } from "@t3tools/client-runtime/spaces/current-space";
import { create } from "zustand";

import { createOrganization, fetchSpaces } from "../environments/primary/spaces";

const STORAGE_KEY = "t3code:current-space:v1";

function readStoredSpace(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeSpace(spaceId: SpaceId) {
  try {
    window.localStorage.setItem(STORAGE_KEY, spaceId);
  } catch {
    // Without storage the choice lasts until reload.
  }
}

interface CurrentSpaceState {
  readonly environmentId: EnvironmentId | null;
  readonly view: SpaceDirectoryView | null;
  readonly currentSpaceId: SpaceId | null;
}

export const useCurrentSpace = create<CurrentSpaceState>(() => ({
  environmentId: null,
  view: null,
  currentSpaceId: null,
}));

export function selectSpace(spaceId: SpaceId) {
  const { environmentId } = useCurrentSpace.getState();
  if (environmentId !== null) setCurrentSpace(environmentId, spaceId);
  storeSpace(spaceId);
  useCurrentSpace.setState({ currentSpaceId: spaceId });
}

/** Loads the primary environment's Spaces; a session without a User has none. */
export async function loadSpaces(environmentId: EnvironmentId): Promise<void> {
  const view = await fetchSpaces().catch(() => null);
  if (view === null) {
    setCurrentSpace(environmentId, null);
    useCurrentSpace.setState({ environmentId, view: null, currentSpaceId: null });
    return;
  }
  const stored = readStoredSpace();
  const current = view.spaces.find((space) => space.id === stored)?.id ?? view.personalSpaceId;
  useCurrentSpace.setState({ environmentId, view });
  selectSpace(current);
}

export async function createAndSelectOrganization(name: string): Promise<void> {
  const { environmentId } = useCurrentSpace.getState();
  const created = await createOrganization(name);
  if (environmentId !== null) await loadSpaces(environmentId);
  selectSpace(created.id);
}
