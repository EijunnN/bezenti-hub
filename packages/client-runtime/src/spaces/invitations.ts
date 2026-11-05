// Invitations into an Organization, shared by web and (ticket 16) mobile. Like Organizations, they
// are HTTP beside the User's account: who may invite depends on the User (the Owner for now), and
// clients show the controls from the server's `canInvite` answer.
import type { InvitationId, InvitationStatus, SpaceId, SpaceRole } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { makeEnvironmentHttpApiClient } from "../rpc/http.ts";

type EnvironmentHttpClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;

export const listInvitations = (client: EnvironmentHttpClient, spaceId: SpaceId) =>
  client.invitations.list({ headers: {}, params: { spaceId } });

export const createInvitation = (
  client: EnvironmentHttpClient,
  spaceId: SpaceId,
  role: SpaceRole,
) => client.invitations.create({ headers: {}, params: { spaceId }, payload: { role } });

export const revokeInvitation = (client: EnvironmentHttpClient, invitationId: InvitationId) =>
  client.invitations.revoke({ headers: {}, payload: { invitationId } });

/** The link to hand the invitee. The token rides in the fragment, which never reaches a server log. */
export const invitationLink = (origin: string, token: string) =>
  `${origin.replace(/\/+$/, "")}/invite#token=${encodeURIComponent(token)}`;

export const SPACE_ROLE_LABELS: Record<SpaceRole, string> = {
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

export const INVITATION_STATUS_LABELS: Record<InvitationStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  expired: "Expired",
  revoked: "Revoked",
};
