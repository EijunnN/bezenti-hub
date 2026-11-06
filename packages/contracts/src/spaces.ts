import * as Schema from "effect/Schema";

import { SpaceId, TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";

export const SpaceKind = Schema.Literals(["organization", "personal"]);
export type SpaceKind = typeof SpaceKind.Type;

/** A Member's fixed Role in one Organization. */
export const SpaceRole = Schema.Literals(["admin", "member", "guest"]);
export type SpaceRole = typeof SpaceRole.Type;

/** Permissions the Owner grants a User outside any Organization. */
export const InstallationPermission = Schema.Literals([
  "personalSpace.create",
  "environments.registerOwn",
]);
export type InstallationPermission = typeof InstallationPermission.Type;

/** A Space as the signed-in User sees it in the Space selector. */
export const SpaceSummary = Schema.Struct({
  id: SpaceId,
  kind: SpaceKind,
  name: TrimmedNonEmptyString,
  /** The viewer's Role; null in a Personal space and for the Owner outside their memberships. */
  role: Schema.NullOr(SpaceRole),
  /** True for the viewer's own Personal space. */
  isOwn: Schema.Boolean,
  /** Whether the viewer may start Threads here. */
  canCreateThreads: Schema.Boolean,
  /** Whether the viewer may invite people here and see and revoke its Invitations. */
  canInvite: Schema.Boolean,
});
export type SpaceSummary = typeof SpaceSummary.Type;

export const SpaceDirectoryView = Schema.Struct({
  /** The viewer, so a client can keep one current Space per User. */
  userId: UserId,
  spaces: Schema.Array(SpaceSummary),
  personalSpaceId: SpaceId,
  canCreateOrganization: Schema.Boolean,
  /** The Installation's Owner, who may act on everything. Optional so older servers decode. */
  isOwner: Schema.optional(Schema.Boolean),
});
export type SpaceDirectoryView = typeof SpaceDirectoryView.Type;

export const CreateOrganizationRequest = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});
export type CreateOrganizationRequest = typeof CreateOrganizationRequest.Type;
