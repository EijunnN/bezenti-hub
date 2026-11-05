import {
  type EnvironmentId,
  EnvironmentHttpForbiddenError,
  type SpaceDirectoryView,
  type SpaceId,
} from "@t3tools/contracts";
import { setCurrentSpace } from "@t3tools/client-runtime/spaces/current-space";
import {
  chooseCurrentSpace,
  createOrganization,
  currentSpaceStorageKey,
  fetchSpaceDirectory,
} from "@t3tools/client-runtime/spaces/space-directory";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";

const isForbidden = Schema.is(EnvironmentHttpForbiddenError);

function readStoredSpace(view: SpaceDirectoryView): string | null {
  try {
    return window.localStorage.getItem(currentSpaceStorageKey(view.userId));
  } catch {
    return null;
  }
}

function storeSpace(view: SpaceDirectoryView, spaceId: SpaceId) {
  try {
    window.localStorage.setItem(currentSpaceStorageKey(view.userId), spaceId);
  } catch {
    // Without storage the choice lasts until reload.
  }
}

interface CurrentSpaceState {
  readonly environmentId: EnvironmentId | null;
  readonly view: SpaceDirectoryView | null;
  readonly currentSpaceId: SpaceId | null;
  /** The last load failed; the previous Spaces and choice stay in place. */
  readonly loadFailed: boolean;
}

export const useCurrentSpace = create<CurrentSpaceState>(() => ({
  environmentId: null,
  view: null,
  currentSpaceId: null,
  loadFailed: false,
}));

export function selectSpace(spaceId: SpaceId) {
  const { environmentId, view } = useCurrentSpace.getState();
  if (environmentId !== null) setCurrentSpace(environmentId, spaceId);
  if (view !== null) storeSpace(view, spaceId);
  useCurrentSpace.setState({ currentSpaceId: spaceId });
}

/** Loads the primary environment's Spaces; sign-in and sign-out reload the page, so this runs per User. */
export async function loadSpaces(environmentId: EnvironmentId): Promise<void> {
  const view = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(fetchSpaceDirectory)),
  ).catch((cause: unknown) => (isForbidden(cause) ? "no-user" : null));
  // A session without a User (before the Owner exists) has no Spaces.
  if (view === "no-user") {
    setCurrentSpace(environmentId, null);
    useCurrentSpace.setState({
      environmentId,
      view: null,
      currentSpaceId: null,
      loadFailed: false,
    });
    return;
  }
  if (view === null) {
    useCurrentSpace.setState({ environmentId, loadFailed: true });
    return;
  }
  const previous = useCurrentSpace.getState().currentSpaceId;
  useCurrentSpace.setState({ environmentId, view, loadFailed: false });
  selectSpace(chooseCurrentSpace(view, previous ?? readStoredSpace(view)));
}

export async function createAndSelectOrganization(name: string): Promise<void> {
  const created = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(Effect.flatMap((client) => createOrganization(client, name))),
  );
  const { environmentId } = useCurrentSpace.getState();
  if (environmentId !== null) await loadSpaces(environmentId);
  selectSpace(created.id);
}
