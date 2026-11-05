// HTTP beside the User's account, not a guarded WS command: creating an Organization depends on
// who the User is (the Owner), not on a session scope, so a permission atom has nothing to read.
// Clients show controls from the server's AccessPolicy answers (`canCreateOrganization`,
// `canCreateThreads`) instead.
import type { SpaceDirectoryView, SpaceSummary, UserId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { makeEnvironmentHttpApiClient } from "../rpc/http.ts";

type EnvironmentHttpClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;

export const fetchSpaceDirectory = (client: EnvironmentHttpClient) =>
  client.spaces.list({ headers: {} });

export const createOrganization = (client: EnvironmentHttpClient, name: string) =>
  client.spaces.createOrganization({ headers: {}, payload: { name } });

/** Where a client keeps its current Space, one per User so a shared browser does not mix them. */
export const currentSpaceStorageKey = (userId: UserId) => `t3code:current-space:v2:${userId}`;

/**
 * The Space to start in: the stored one while it is still listed, otherwise the first the User
 * can create in (their Personal space only once they hold that permission), else Personal.
 */
export function chooseCurrentSpace(
  view: SpaceDirectoryView,
  stored: string | null,
): SpaceSummary["id"] {
  const kept = view.spaces.find((space) => space.id === stored);
  if (kept !== undefined) return kept.id;
  return view.spaces.find((space) => space.canCreateThreads)?.id ?? view.personalSpaceId;
}
