import * as Schema from "effect/Schema";

import { SpaceId, TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";

/**
 * Every action the audit log records. Closed: a new sensitive action adds its name here and
 * records it from its service. `secret.*` and `environment.register` are recorded by the specs
 * that own secrets and Environments.
 */
export const AuditAction = Schema.Literals([
  "owner.bootstrap",
  "owner.resetLink",
  "resetLink.redeem",
  "invitation.create",
  "invitation.accept",
  "invitation.revoke",
  "membership.changeRole",
  "membership.remove",
  "membership.leave",
  "membership.resetLink",
  "installationPermission.grant",
  "installationPermission.revoke",
  "user.disable",
  "user.enable",
  "user.remove",
  "organization.archive",
  "organization.restore",
  "organization.delete",
  "project.move",
  "project.delete",
  "thread.delete",
  "guestLink.create",
  "appSignIn.approve",
  "mcpClient.approve",
  "cliSession.issue",
  "secret.reveal",
  "secret.edit",
  "environment.register",
]);
export type AuditAction = typeof AuditAction.Type;

export const AuditTargetKind = Schema.Literals([
  "user",
  "space",
  "invitation",
  "project",
  "thread",
  "session",
  "secret",
  "environment",
]);
export type AuditTargetKind = typeof AuditTargetKind.Type;

/** Who acted: a signed-in User, the Hub's shell (`t3 ...`), or the server's own work. */
export const AuditActorSource = Schema.Literals(["user", "cli", "system"]);
export type AuditActorSource = typeof AuditActorSource.Type;

/** Small facts about the action. Never a token, password, code or secret value. */
export const AuditDetail = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
);
export type AuditDetail = typeof AuditDetail.Type;

export const AuditEntry = Schema.Struct({
  id: Schema.Number,
  at: Schema.DateTimeUtc,
  actor: Schema.Struct({
    source: AuditActorSource,
    userId: Schema.NullOr(UserId),
    /** Still resolves for a removed User. */
    displayName: Schema.NullOr(Schema.String),
  }),
  space: Schema.NullOr(Schema.Struct({ id: SpaceId, name: Schema.NullOr(Schema.String) })),
  action: AuditAction,
  target: Schema.Struct({
    kind: AuditTargetKind,
    id: Schema.String,
    /** Its name now, else its name when the action happened. */
    name: Schema.NullOr(Schema.String),
  }),
  detail: AuditDetail,
});
export type AuditEntry = typeof AuditEntry.Type;

export const AuditLogPage = Schema.Struct({
  entries: Schema.Array(AuditEntry),
  /** Pass as `before` for the next, older page; null on the last page. */
  nextCursor: Schema.NullOr(Schema.String),
});
export type AuditLogPage = typeof AuditLogPage.Type;

/** Newest first. Dates are ISO 8601; `from` is inclusive and `to` exclusive. */
export const AuditLogQuery = Schema.Struct({
  action: Schema.optional(AuditAction),
  actorUserId: Schema.optional(UserId),
  spaceId: Schema.optional(SpaceId),
  from: Schema.optional(TrimmedNonEmptyString),
  to: Schema.optional(TrimmedNonEmptyString),
  before: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(TrimmedNonEmptyString),
});
export type AuditLogQuery = typeof AuditLogQuery.Type;
