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
  /**
   * True for the viewer's own Personal space. The Owner also lists every other User's Personal
   * space (kind `personal`, not own) to read it; they are named after their User.
   */
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

/** A User as the Owner sees them in the Users admin view. */
export const InstallationUser = Schema.Struct({
  id: UserId,
  displayName: Schema.String,
  loginName: Schema.NullOr(Schema.String),
  isOwner: Schema.Boolean,
  /** What the Owner granted them; the Owner holds every permission and lists none. */
  installationPermissions: Schema.Array(InstallationPermission),
});
export type InstallationUser = typeof InstallationUser.Type;

export const InstallationUserList = Schema.Struct({ users: Schema.Array(InstallationUser) });
export type InstallationUserList = typeof InstallationUserList.Type;

export const SetInstallationPermissionRequest = Schema.Struct({
  permission: InstallationPermission,
  granted: Schema.Boolean,
});
export type SetInstallationPermissionRequest = typeof SetInstallationPermissionRequest.Type;
