import { type EnvironmentId, HUB_MACHINE_ENVIRONMENT_ID, SpaceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** The Space a Sandbox's Environment id names, whether or not the Sandbox exists yet. */
export const sandboxSpaceOf = (environmentId: EnvironmentId) =>
  environmentId.startsWith("sandbox:")
    ? SpaceId.make(environmentId.slice("sandbox:".length))
    : undefined;

/** A Thread no longer in the Sandbox's Space (its Project moved): nothing new runs for it there. */
export class SandboxSpaceMismatchError extends Schema.TaggedError<SandboxSpaceMismatchError>()(
  "SandboxSpaceMismatchError",
  { environmentId: Schema.String, threadId: Schema.String },
) {
  override get message(): string {
    return "This Thread is no longer in its Sandbox's Space. Move it to another Environment.";
  }
}

/** The Hub could not read which Space an Environment serves: nothing runs there until it can. */
export class SpaceCheckUnavailableError extends Schema.TaggedError<SpaceCheckUnavailableError>()(
  "SpaceCheckUnavailableError",
  { environmentId: Schema.String, cause: Schema.Defect() },
) {
  readonly retryable = true;
  override get message(): string {
    return "The Hub could not check this Environment's Space. Try again.";
  }
}

/**
 * The Space an Environment serves alone: a Sandbox's, or a dedicated machine's; undefined for
 * one that serves its owner anywhere. A failed read fails, never reads as "no Space".
 */
export const boundSpaceOf = Effect.fn("boundSpaceOf")(function* (environmentId: EnvironmentId) {
  const sandboxSpace = sandboxSpaceOf(environmentId);
  if (sandboxSpace !== undefined) return sandboxSpace;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly spaceId: string }>`
    SELECT space_id AS "spaceId" FROM environments
    WHERE environment_id = ${environmentId} AND mode = 'dedicated' AND space_id IS NOT NULL
  `.pipe(Effect.mapError((cause) => new SpaceCheckUnavailableError({ environmentId, cause })));
  const spaceId = rows[0]?.spaceId;
  return spaceId === undefined ? undefined : SpaceId.make(spaceId);
});

/** Why a machine does not run Threads of a Space; each refusal says it in its own words. */
export type SpaceRefusal =
  | "other-space"
  | "owner-left"
  | "revoked"
  | "undedicated"
  | "unknown-machine";

export const SPACE_REFUSAL_MESSAGES: Readonly<Record<SpaceRefusal, string>> = {
  "other-space": "This Thread is no longer in its machine's Space. Move it to another Environment.",
  "owner-left":
    "This Thread's machine belongs to someone no longer in its Space. Move it to another Environment.",
  revoked: "This Thread's machine was removed from the Hub. Move it to another Environment.",
  undedicated:
    "This Thread's machine is not dedicated to any Space now. Move it to another Environment.",
  "unknown-machine": "The Hub does not know this Thread's machine. Move it to another Environment.",
};

/**
 * Why the Environment does not run Threads of `spaceId`, or undefined when it does: the Hub
 * machine runs any; a removed or unknown machine none; a Sandbox or dedicated machine its own
 * Space's; a personal machine while its enabled owner is the Owner or in that Space (any Role).
 */
export const spaceRefusalOf = Effect.fn("spaceRefusalOf")(function* (
  environmentId: EnvironmentId,
  spaceId: string | null,
) {
  if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly kind: string;
    readonly mode: string;
    readonly spaceId: string | null;
    readonly revoked: number;
    readonly usable: number;
  }>`
    SELECT e.kind AS kind, e.mode AS mode, e.space_id AS "spaceId",
      e.revoked_at IS NOT NULL AS revoked,
      COALESCE(u.removed_at IS NULL AND u.disabled_at IS NULL AND (
        u.is_owner = 1
        OR ${spaceId} = 'personal:' || u.user_id
        OR EXISTS (SELECT 1 FROM space_memberships m
          WHERE m.user_id = u.user_id AND m.space_id = ${spaceId})
      ), 0) AS usable
    FROM environments e LEFT JOIN users u ON u.user_id = e.owner_user_id
    WHERE e.environment_id = ${environmentId}
  `.pipe(Effect.mapError((cause) => new SpaceCheckUnavailableError({ environmentId, cause })));
  if (row === undefined) return "unknown-machine" as const;
  if (row.revoked === 1) return "revoked" as const;
  if (row.kind === "hub") return undefined;
  if (row.kind === "sandbox" || row.mode === "dedicated") {
    if (row.spaceId === null) return "undedicated" as const;
    return row.spaceId === spaceId ? undefined : ("other-space" as const);
  }
  return row.usable === 1 ? undefined : ("owner-left" as const);
});

/** Whether the Environment runs Threads of `spaceId` (`spaceRefusalOf` says why not). */
export const servesSpace = (environmentId: EnvironmentId, spaceId: string | null) =>
  Effect.map(spaceRefusalOf(environmentId, spaceId), (refusal) => refusal === undefined);
