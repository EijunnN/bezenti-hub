/**
 * The Sandbox limits the Hub keeps: the Installation's defaults (`sandbox_limit_defaults`) and each
 * Space's own (`space_sandbox_limits`, migration 108), read the same way for a Hub's Sandbox and a
 * dedicated machine's, and changed by the Owner, audited. See docs/internals/sandboxes.md#limits.
 */
import { type EnvironmentId, type SandboxLimitsChange, type SpaceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import {
  BUILT_IN_DEFAULT_LIMITS,
  effectiveLimits,
  type HostCapacity,
  invalidLimitsReason,
  NO_LIMITS,
  type SandboxLimits,
} from "./sandboxLimits.ts";

export class SandboxLimitsInvalidError extends Schema.TaggedError<SandboxLimitsInvalidError>()(
  "SandboxLimitsInvalidError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** The Space has neither a Hub Sandbox nor a dedicated machine to set limits for. */
export class SandboxNotFoundError extends Schema.TaggedError<SandboxNotFoundError>()(
  "SandboxNotFoundError",
  { spaceId: Schema.String },
) {}

const COLUMNS = `cpu_limit AS cpus, memory_limit_bytes AS "memoryBytes", pids_limit AS pids,
  disk_limit_bytes AS "diskBytes"`;

/** The Installation's defaults (migration 104's row; the built-in ones if it is gone). */
export const readDefaultLimits = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<SandboxLimits>`
    SELECT ${sql.literal(COLUMNS)} FROM sandbox_limit_defaults WHERE id = 1
  `;
  return row ?? BUILT_IN_DEFAULT_LIMITS;
});

/** The Space's own values; null (or no row) takes the default. */
const readSpaceOverrides = Effect.fn("sandboxLimitStore.readSpaceOverrides")(function* (
  spaceId: SpaceId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<SandboxLimits>`
    SELECT ${sql.literal(COLUMNS)} FROM space_sandbox_limits WHERE space_id = ${spaceId}
  `;
  return row ?? NO_LIMITS;
});

/** What the Space's Sandbox starts with, wherever it runs: its own values over the defaults. */
export const readSpaceLimits = Effect.fn("sandboxLimitStore.readSpaceLimits")(function* (
  spaceId: SpaceId,
) {
  return effectiveLimits(yield* readDefaultLimits, yield* readSpaceOverrides(spaceId));
});

/**
 * Each Space's own values and what its Sandbox starts with, as Settings shows their rows: the
 * defaults read once, every Space's own in one query.
 */
export const readSpacesLimitsWithOwn = Effect.fn("sandboxLimitStore.readSpacesLimitsWithOwn")(
  function* (spaceIds: ReadonlyArray<SpaceId>) {
    const result = new Map<
      SpaceId,
      { readonly own: SandboxLimits; readonly effective: SandboxLimits }
    >();
    if (spaceIds.length === 0) return result;
    const sql = yield* SqlClient.SqlClient;
    const defaults = yield* readDefaultLimits;
    const rows = yield* sql<SandboxLimits & { readonly spaceId: SpaceId }>`
      SELECT space_id AS "spaceId", ${sql.literal(COLUMNS)} FROM space_sandbox_limits
      WHERE space_id IN ${sql.in(spaceIds)}
    `;
    const owns = new Map(rows.map(({ spaceId, ...own }) => [spaceId, own]));
    for (const spaceId of spaceIds) {
      const own = owns.get(spaceId) ?? NO_LIMITS;
      result.set(spaceId, { own, effective: effectiveLimits(defaults, own) });
    }
    return result;
  },
);

/** Whether the Space has a machine of its own, which may be bigger than the Hub's. */
const hasDedicatedMachine = Effect.fn("sandboxLimitStore.hasDedicatedMachine")(function* (
  spaceId: SpaceId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM environments
    WHERE mode = 'dedicated' AND space_id = ${spaceId} AND revoked_at IS NULL
  `;
  return (row?.count ?? 0) > 0;
});

/**
 * Changes the Installation's defaults (no `spaceId`) or a Space's own, audited, after checking them
 * against `host` (the Hub's machine). A Space with a dedicated machine may be given more CPUs and
 * memory than the Hub has: each machine starts its Sandbox with at most what it has.
 */
export const changeLimits = Effect.fn("sandboxLimitStore.changeLimits")(function* (input: {
  readonly spaceId: SpaceId | undefined;
  /** Only the values given change; null clears one. */
  readonly limits: SandboxLimitsChange;
  readonly actor: AuditLog.AuditActor;
  readonly host: HostCapacity;
  /** The Environment the Owner set them on (its Sandbox or dedicated machine), for the audit. */
  readonly environmentId?: EnvironmentId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const audit = yield* AuditLog.AuditLog;
  const { spaceId } = input;
  const current =
    spaceId === undefined ? yield* readDefaultLimits : yield* readSpaceOverrides(spaceId);
  const limits: SandboxLimits = { ...current, ...input.limits };
  const dedicated = spaceId !== undefined && (yield* hasDedicatedMachine(spaceId));
  const invalid = invalidLimitsReason(
    limits,
    dedicated ? { ...input.host, cpus: Infinity, memoryBytes: Infinity } : input.host,
  );
  if (invalid !== undefined) return yield* new SandboxLimitsInvalidError({ reason: invalid });
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (spaceId === undefined) {
        yield* sql`
          INSERT INTO sandbox_limit_defaults (
            id, cpu_limit, memory_limit_bytes, pids_limit, disk_limit_bytes, updated_at
          ) VALUES (
            1, ${limits.cpus}, ${limits.memoryBytes}, ${limits.pids}, ${limits.diskBytes}, ${now}
          )
          ON CONFLICT (id) DO UPDATE SET cpu_limit = excluded.cpu_limit,
            memory_limit_bytes = excluded.memory_limit_bytes,
            pids_limit = excluded.pids_limit, disk_limit_bytes = excluded.disk_limit_bytes,
            updated_at = excluded.updated_at
        `;
      } else {
        const [sandbox] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM sandboxes WHERE space_id = ${spaceId}
        `;
        if ((sandbox?.count ?? 0) === 0 && !dedicated) {
          return yield* new SandboxNotFoundError({ spaceId });
        }
        yield* sql`
          INSERT INTO space_sandbox_limits (
            space_id, cpu_limit, memory_limit_bytes, pids_limit, disk_limit_bytes, updated_at
          ) VALUES (
            ${spaceId}, ${limits.cpus}, ${limits.memoryBytes}, ${limits.pids},
            ${limits.diskBytes}, ${now}
          )
          ON CONFLICT (space_id) DO UPDATE SET cpu_limit = excluded.cpu_limit,
            memory_limit_bytes = excluded.memory_limit_bytes,
            pids_limit = excluded.pids_limit, disk_limit_bytes = excluded.disk_limit_bytes,
            updated_at = excluded.updated_at
        `;
      }
      yield* audit.record({
        actor: input.actor,
        action: "sandbox.limits.change",
        spaceId: spaceId ?? null,
        target:
          input.environmentId === undefined
            ? { kind: "environment", id: "sandboxes", name: "Default Sandbox limits" }
            : { kind: "environment", id: input.environmentId },
        detail: {
          scope: spaceId === undefined ? "defaults" : "space",
          cpus: limits.cpus,
          memoryBytes: limits.memoryBytes,
          pids: limits.pids,
          diskBytes: limits.diskBytes,
        },
      });
    }),
  );
  return {
    own: limits,
    effective: spaceId === undefined ? limits : yield* readSpaceLimits(spaceId),
  };
});

/** The Space is deleted: its own limits go with it. */
export const deleteSpaceLimits = Effect.fn("sandboxLimitStore.deleteSpaceLimits")(function* (
  spaceId: SpaceId,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM space_sandbox_limits WHERE space_id = ${spaceId}`;
});
