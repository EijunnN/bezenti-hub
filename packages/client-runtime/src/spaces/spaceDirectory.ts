// HTTP beside the User's account, not a guarded WS command: creating an Organization depends on
// who the User is (the Owner), not on a session scope, so a permission atom has nothing to read.
// Clients show controls from the server's AccessPolicy answers (`canCreateOrganization`,
// `canCreateThreads`) instead.
import type {
  InstallationPermission,
  InstallationUserStatus,
  SpaceDirectoryView,
  SpaceSummary,
  UserId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { makeEnvironmentHttpApiClient } from "../rpc/http.ts";

type EnvironmentHttpClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;

export const fetchSpaceDirectory = (client: EnvironmentHttpClient) =>
  client.spaces.list({ headers: {} });

export const createOrganization = (client: EnvironmentHttpClient, name: string) =>
  client.spaces.createOrganization({ headers: {}, payload: { name } });

/** The Owner's Users admin view. */
export const fetchInstallationUsers = (client: EnvironmentHttpClient) =>
  client.installationUsers.list({ headers: {} });

export const setInstallationPermission = (
  client: EnvironmentHttpClient,
  userId: UserId,
  permission: InstallationPermission,
  granted: boolean,
) =>
  client.installationUsers.setPermission({
    headers: {},
    params: { userId },
    payload: { permission, granted },
  });

/** Disables, re-enables or removes a User; removing cannot be undone. */
export const setInstallationUserStatus = (
  client: EnvironmentHttpClient,
  userId: UserId,
  status: InstallationUserStatus,
) => client.installationUsers.setStatus({ headers: {}, params: { userId }, payload: { status } });

export const INSTALLATION_PERMISSION_LABELS: Record<InstallationPermission, string> = {
  "personalSpace.create": "Use their Personal space",
  "environments.registerOwn": "Register their own Environments",
};

/** Where a client keeps its current Space, one per User so a shared browser does not mix them. */
export const currentSpaceStorageKey = (userId: UserId) => `t3code:current-space:v2:${userId}`;

/**
 * The Space to start in: the stored one while it is still listed, otherwise the first the User
 * can create in (their Personal space is listed only once they hold that permission), else the
 * first listed, else none: a hidden Personal space is never chosen.
 */
export function chooseCurrentSpace(
  view: SpaceDirectoryView,
  stored: string | null,
): SpaceSummary["id"] | null {
  const kept = view.spaces.find((space) => space.id === stored);
  if (kept !== undefined) return kept.id;
  return view.spaces.find((space) => space.canCreateThreads)?.id ?? view.spaces[0]?.id ?? null;
}
