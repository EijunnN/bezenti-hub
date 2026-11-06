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
  /**
   * The viewer was made Admin here but acts as a Member until they add an authenticator app
   * (or have a passkey). Optional so older servers decode.
   */
  pendingAdmin: Schema.optional(Schema.Boolean),
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

/** Someone in an Organization, with what the viewer may do to them. */
export const MemberSummary = Schema.Struct({
  userId: UserId,
  displayName: Schema.String,
  role: SpaceRole,
  isYou: Schema.Boolean,
  canChangeRole: Schema.Boolean,
  canRemove: Schema.Boolean,
  /** Made Admin, acting as a Member until they have a passkey or an authenticator app. */
  pendingAdmin: Schema.Boolean,
  /** Whether the viewer (only the Owner) may give them a one-time link to reset their sign-in. */
  canIssueResetLink: Schema.Boolean,
});
export type MemberSummary = typeof MemberSummary.Type;

export const MemberList = Schema.Struct({
  members: Schema.Array(MemberSummary),
  /** The Roles the viewer may give, in Invitations and Role changes: Admin only for the Owner. */
  assignableRoles: Schema.Array(SpaceRole),
  canLeave: Schema.Boolean,
});
export type MemberList = typeof MemberList.Type;

export const MemberRequest = Schema.Struct({ userId: UserId });
export type MemberRequest = typeof MemberRequest.Type;

export const ChangeMemberRoleRequest = Schema.Struct({ userId: UserId, role: SpaceRole });
export type ChangeMemberRoleRequest = typeof ChangeMemberRoleRequest.Type;

export const ChangeMemberRoleResult = Schema.Struct({
  member: MemberSummary,
  /** A new Admin with no passkey or authenticator app, who acts as a Member until they add one. */
  pendingAdmin: Schema.Boolean,
  /** A new Admin whose password needs no code yet: their sessions ended, a passkey signs in. */
  signedOut: Schema.Boolean,
});
export type ChangeMemberRoleResult = typeof ChangeMemberRoleResult.Type;

/** Shown once: the server keeps only its hash. The link is `<origin>/reset#token=<token>`. */
export const MemberResetLink = Schema.Struct({
  token: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type MemberResetLink = typeof MemberResetLink.Type;
