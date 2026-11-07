import * as Schema from "effect/Schema";

import { SpaceId, TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";

/**
 * Every action the audit log records. Closed: a new sensitive action adds its name here and
 * records it from its service. `secret.*` are recorded by the spec that owns secrets.
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
  "environment.rename",
  "environment.remove",
  "environment.mode.change",
  "thread.move",
  "sandbox.create",
  "sandbox.start",
  "sandbox.stop",
  "sandbox.delete",
  "sandbox.image.update",
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

/**
 * Who acted: a signed-in User, an agent acting as its User (MCP tools, a Thread's agent), the
 * Hub's shell (`t3 ...`, as `--user` when given), or the server's own work.
 */
export const AuditActorSource = Schema.Literals(["user", "agent", "cli", "system"]);
export type AuditActorSource = typeof AuditActorSource.Type;

/**
 * The only detail keys each action may carry; anything else is dropped on write. Values are ids,
 * enums, counts and names already shown elsewhere, never a token, password, code or secret.
 */
export const AUDIT_DETAIL_KEYS = {
  "owner.bootstrap": [],
  "owner.resetLink": [],
  "resetLink.redeem": ["method"],
  "invitation.create": ["role"],
  "invitation.accept": ["role", "newUser"],
  "invitation.revoke": ["role"],
  "membership.changeRole": ["from", "to"],
  "membership.remove": [],
  "membership.leave": [],
  "membership.resetLink": [],
  "installationPermission.grant": ["permission"],
  "installationPermission.revoke": ["permission"],
  "user.disable": ["from"],
  "user.enable": ["from"],
  "user.remove": ["from"],
  "organization.archive": [],
  "organization.restore": [],
  "organization.delete": [],
  "project.move": ["fromSpaceId"],
  "project.delete": [],
  "thread.delete": ["via"],
  "guestLink.create": ["expiresAt"],
  "appSignIn.approve": ["client", "redirect"],
  "mcpClient.approve": ["client", "access", "method"],
  "cliSession.issue": ["sessionId", "label", "scopes"],
  "secret.reveal": ["vault"],
  "secret.edit": ["vault"],
  /** `mode` personal or dedicated (with its `spaceId`), `via` join (or, later, ssh). */
  "environment.register": ["kind", "os", "mode", "spaceId", "via"],
  "environment.rename": ["from", "to"],
  /** `settings` from the Hub, `leave` from the machine, `userTurnedOff` with its owner. */
  "environment.remove": ["via"],
  /** Modes (`personal`, `dedicated`) and Spaces (null for personal) before and after. */
  "environment.mode.change": ["from", "to", "fromSpaceId", "toSpaceId"],
  /**
   * Environment ids; `started`, `switched`, `failed` or `cancelled`; the failed step and its
   * trimmed message; what the target continues from; whether the source was offline; set-aside refs.
   */
  "thread.move": [
    "from",
    "to",
    "outcome",
    "failedStep",
    "failureMessage",
    "continuesFrom",
    "continuesFromRef",
    "sourceOffline",
    "setAside",
  ],
  /** Which Sandbox runtime made it (process or podman). */
  "sandbox.create": ["runtime"],
  /**
   * `demand`: work needed it; `retry`: a User's «Try again»; `update`: moved to a new image.
   * `started` or `failed`, with the trimmed reason.
   */
  "sandbox.start": ["via", "outcome", "reason"],
  /**
   * `archived`: its Organization was; `idle`: nothing ran in it for the idle timeout; `update`:
   * the Owner moved it to a new image.
   */
  "sandbox.stop": ["via"],
  "sandbox.delete": [],
  /**
   * `build`: the base image was built from `settings` or the `cli` (`outcome` `built` or
   * `failed`, the new `version` or the trimmed `reason`); `restart`: a running Sandbox moved
   * `from` one version to `version` at the Owner's request.
   */
  "sandbox.image.update": ["via", "outcome", "version", "from", "reason"],
} as const satisfies Record<AuditAction, ReadonlyArray<string>>;

export type AuditDetailOf<A extends AuditAction> = {
  readonly [K in (typeof AUDIT_DETAIL_KEYS)[A][number]]?: string | number | boolean | null;
};

/** Small facts about the action, limited to `AUDIT_DETAIL_KEYS` for its action. */
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
  /** Every Space the log names, deleted ones too, to filter by. */
  spaces: Schema.Array(
    Schema.Struct({ id: SpaceId, name: Schema.NullOr(Schema.String), deleted: Schema.Boolean }),
  ),
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
