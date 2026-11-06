// HTTP beside the User's account, not a guarded WS command: creating an Organization depends on
// who the User is (the Owner), not on a session scope, so a permission atom has nothing to read.
// Clients show controls from the server's AccessPolicy answers (`canCreateOrganization`,
// `canCreateThreads`) instead.
import type {
  CommandId,
  InstallationPermission,
  ProjectId,
  SpaceDirectoryView,
  SpaceId,
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

/** The Owner archives, restores and (once archived) deletes an Organization. */
export const archiveOrganization = (client: EnvironmentHttpClient, spaceId: SpaceId) =>
  client.spaces.archiveOrganization({ headers: {}, params: { spaceId } });
export const restoreOrganization = (client: EnvironmentHttpClient, spaceId: SpaceId) =>
  client.spaces.restoreOrganization({ headers: {}, params: { spaceId } });
export const deleteOrganization = (client: EnvironmentHttpClient, spaceId: SpaceId) =>
  client.spaces.deleteOrganization({ headers: {}, params: { spaceId } });

/** Moves a Project with all its Threads to another Space; refused while one of them runs. */
export const moveProject = (
  client: EnvironmentHttpClient,
  input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly spaceId: SpaceId;
  },
) => client.projects.mutate({ headers: {}, payload: { type: "project.move", ...input } });

/**
 * The Spaces a Project in `from` may move to, from the server's answers per Space. A Project
 * from before Spaces (no Space) is in the Owner's Personal space. Empty when it may not leave.
 */
export function projectMoveDestinations(
  view: SpaceDirectoryView,
  from: SpaceId | null | undefined,
): ReadonlyArray<SpaceSummary> {
  const origin = from ?? (view.isOwner === true ? view.personalSpaceId : null);
  const source = view.spaces.find((space) => space.id === origin);
  if (source === undefined || source.canMoveProjectsOut !== true) return [];
  return view.spaces.filter((space) => space.id !== origin && space.canMoveProjectsIn === true);
}

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
