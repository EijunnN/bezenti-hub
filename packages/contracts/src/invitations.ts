import * as Schema from "effect/Schema";

import { AuthBrowserSessionResult } from "./auth.ts";
import { makeEntityId, SpaceId, TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";
import { SpaceRole } from "./spaces.ts";
import {
  AuthLoginName,
  AuthPassword,
  AuthPasskeyRegistrationResponse,
  AuthTotpCode,
} from "./userAccounts.ts";

export const InvitationId = makeEntityId("InvitationId");
export type InvitationId = typeof InvitationId.Type;

// The link's secret: 32 random bytes in base64url. Unauthenticated endpoints take it, so it is bounded.
export const InvitationToken = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const BoundedId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const InvitationStatus = Schema.Literals(["pending", "accepted", "expired", "revoked"]);
export type InvitationStatus = typeof InvitationStatus.Type;

/** An Invitation as the people who manage an Organization's Invitations see it. */
export const InvitationSummary = Schema.Struct({
  id: InvitationId,
  spaceId: SpaceId,
  role: SpaceRole,
  status: InvitationStatus,
  createdByName: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  acceptedByName: Schema.NullOr(Schema.String),
  acceptedAt: Schema.NullOr(Schema.DateTimeUtc),
  revokedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type InvitationSummary = typeof InvitationSummary.Type;

export const CreateInvitationRequest = Schema.Struct({ role: SpaceRole });
export type CreateInvitationRequest = typeof CreateInvitationRequest.Type;

export const CreatedInvitation = Schema.Struct({
  invitation: InvitationSummary,
  /** Shown once: the server keeps only its hash. The link is `<origin>/invite#token=<token>`. */
  token: TrimmedNonEmptyString,
});
export type CreatedInvitation = typeof CreatedInvitation.Type;

export const InvitationList = Schema.Struct({ invitations: Schema.Array(InvitationSummary) });
export type InvitationList = typeof InvitationList.Type;

export const RevokeInvitationRequest = Schema.Struct({ invitationId: InvitationId });
export type RevokeInvitationRequest = typeof RevokeInvitationRequest.Type;

export const InvitationTokenRequest = Schema.Struct({ token: InvitationToken });
export type InvitationTokenRequest = typeof InvitationTokenRequest.Type;

/**
 * What the invitee sees before accepting. Expired, revoked, used and unknown links, and links into
 * an archived Organization, all answer `invalid` alike.
 */
export const InvitationPreview = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("valid"),
    organizationName: Schema.String,
    role: SpaceRole,
    inviterName: Schema.String,
    expiresAt: Schema.DateTimeUtc,
  }),
  Schema.Struct({ status: Schema.Literal("invalid") }),
]);
export type InvitationPreview = typeof InvitationPreview.Type;

const InviteeDisplayName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

export const InvitationRegistrationRequest = Schema.Struct({
  token: InvitationToken,
  displayName: InviteeDisplayName,
});
export type InvitationRegistrationRequest = typeof InvitationRegistrationRequest.Type;

/** Creates a new User from the Invitation, with a passkey or a password (plus TOTP for Admins). */
export const AcceptInvitationRequest = Schema.Union([
  Schema.Struct({
    token: InvitationToken,
    method: Schema.Literal("passkey"),
    ceremonyId: BoundedId,
    response: AuthPasskeyRegistrationResponse,
  }),
  Schema.Struct({
    token: InvitationToken,
    method: Schema.Literal("password"),
    displayName: InviteeDisplayName,
    loginName: AuthLoginName,
    password: AuthPassword,
    /** Required for an Admin Invitation: a code from the enrollment started for this link. */
    totp: Schema.optionalKey(Schema.Struct({ enrollmentId: BoundedId, code: AuthTotpCode })),
  }),
]);
export type AcceptInvitationRequest = typeof AcceptInvitationRequest.Type;

export const AcceptInvitationResult = Schema.Struct({
  session: AuthBrowserSessionResult,
  userId: UserId,
  spaceId: SpaceId,
});
export type AcceptInvitationResult = typeof AcceptInvitationResult.Type;

/** A signed-in User adding the Invitation's Organization to their own User. */
export const JoinInvitationResult = Schema.Struct({ userId: UserId, spaceId: SpaceId });
export type JoinInvitationResult = typeof JoinInvitationResult.Type;
