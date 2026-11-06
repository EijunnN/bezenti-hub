// Who is in an Organization, shared by web and (ticket 16) mobile. HTTP beside the User's
// account, like Invitations: what the viewer may do to each Member comes from the server's
// AccessPolicy answers in the list (`canChangeRole`, `canRemove`, `canIssueResetLink`).
import type { SpaceId, SpaceRole, UserId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { makeEnvironmentHttpApiClient } from "../rpc/http.ts";

type EnvironmentHttpClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;

export const listMembers = (client: EnvironmentHttpClient, spaceId: SpaceId) =>
  client.spaces.members({ headers: {}, params: { spaceId } });

export const changeMemberRole = (
  client: EnvironmentHttpClient,
  spaceId: SpaceId,
  userId: UserId,
  role: SpaceRole,
) =>
  client.spaces.changeMemberRole({ headers: {}, params: { spaceId }, payload: { userId, role } });

export const removeMember = (client: EnvironmentHttpClient, spaceId: SpaceId, userId: UserId) =>
  client.spaces.removeMember({ headers: {}, params: { spaceId }, payload: { userId } });

export const issueMemberResetLink = (
  client: EnvironmentHttpClient,
  spaceId: SpaceId,
  userId: UserId,
) => client.spaces.issueMemberResetLink({ headers: {}, params: { spaceId }, payload: { userId } });

export const leaveOrganization = (client: EnvironmentHttpClient, spaceId: SpaceId) =>
  client.spaces.leave({ headers: {}, params: { spaceId } });

/** The link to hand the Member. The token rides in the fragment, which never reaches a server log. */
export const resetLink = (origin: string, token: string) =>
  `${origin.replace(/\/+$/, "")}/reset#token=${encodeURIComponent(token)}`;
