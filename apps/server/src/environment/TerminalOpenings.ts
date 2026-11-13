/**
 * Spec 5 ticket 07: each terminal's Space at open and its opener. One whose Thread left that Space,
 * or whose opener was removed, is refused by the Hub and closed on its machine, now or when it
 * connects (`close_pending_at`). docs/internals/secrets.md, «Losing reach».
 */
import type { EnvironmentId, ProjectId, SpaceId, UserId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export interface TerminalKey {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly terminalId: string;
}

export interface TerminalOpening extends TerminalKey {
  readonly spaceId: string;
  readonly openedBy: string | null;
  readonly pending: boolean;
  readonly openerRemoved: boolean;
}

const now = Effect.map(DateTime.now, DateTime.formatIso);

/** A terminal opened (or attached) under `spaceId`; one already recorded keeps its first opener. */
export const record = (
  sql: SqlClient.SqlClient,
  input: TerminalKey & { readonly spaceId: SpaceId; readonly openedBy: UserId | undefined },
) =>
  Effect.flatMap(
    now,
    (at) => sql`
      INSERT INTO terminal_openings (environment_id, thread_id, terminal_id, space_id, opened_by, opened_at)
      VALUES (${input.environmentId}, ${input.threadId}, ${input.terminalId}, ${input.spaceId}, ${input.openedBy ?? null}, ${at})
      ON CONFLICT (environment_id, thread_id, terminal_id) DO NOTHING
    `,
  ).pipe(Effect.asVoid);

/** What the Hub recorded of one terminal, if anything. */
export const find = (sql: SqlClient.SqlClient, key: TerminalKey) =>
  sql<{
    readonly spaceId: string;
    readonly openedBy: string | null;
    readonly pending: number;
    readonly openerRemoved: number;
  }>`
    SELECT o.space_id AS "spaceId", o.opened_by AS "openedBy",
      o.close_pending_at IS NOT NULL AS pending,
      COALESCE(u.removed_at IS NOT NULL, 0) AS "openerRemoved"
    FROM terminal_openings o LEFT JOIN users u ON u.user_id = o.opened_by
    WHERE o.environment_id = ${key.environmentId} AND o.thread_id = ${key.threadId}
      AND o.terminal_id = ${key.terminalId}
  `.pipe(
    Effect.map(([row]): TerminalOpening | undefined =>
      row === undefined
        ? undefined
        : {
            ...key,
            spaceId: row.spaceId,
            openedBy: row.openedBy,
            pending: row.pending === 1,
            openerRemoved: row.openerRemoved === 1,
          },
    ),
  );

/** One terminal to close, on its machine, as soon as it can be. */
export const markOne = (sql: SqlClient.SqlClient, key: TerminalKey) =>
  Effect.flatMap(
    now,
    (at) => sql`
      UPDATE terminal_openings SET close_pending_at = COALESCE(close_pending_at, ${at})
      WHERE environment_id = ${key.environmentId} AND thread_id = ${key.threadId}
        AND terminal_id = ${key.terminalId}
    `,
  ).pipe(Effect.asVoid);

/**
 * A Project moved to `spaceId`: its Threads' terminals opened under another Space are to close.
 * Those opened under `spaceId` (on a rerun that finishes a move) stay.
 */
export const markProjectMoved = (
  sql: SqlClient.SqlClient,
  input: { readonly projectId: ProjectId; readonly spaceId: SpaceId },
) =>
  Effect.flatMap(
    now,
    (at) => sql`
      UPDATE terminal_openings SET close_pending_at = ${at}
      WHERE close_pending_at IS NULL AND space_id <> ${input.spaceId} AND thread_id IN (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE project_id = ${input.projectId}
      )
    `,
  ).pipe(Effect.asVoid);

/** A User removed: every terminal they opened is to close, whoever's Thread it is in. */
export const markOpener = (sql: SqlClient.SqlClient, userId: UserId) =>
  Effect.flatMap(
    now,
    (at) => sql`
      UPDATE terminal_openings SET close_pending_at = ${at}
      WHERE close_pending_at IS NULL AND opened_by = ${userId}
    `,
  ).pipe(Effect.asVoid);

/** The terminals waiting to close, oldest first. */
export const pending = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly environmentId: EnvironmentId;
    readonly threadId: string;
    readonly terminalId: string;
  }>`
    SELECT environment_id AS "environmentId", thread_id AS "threadId", terminal_id AS "terminalId"
    FROM terminal_openings WHERE close_pending_at IS NOT NULL ORDER BY close_pending_at
  `;

/** A terminal closed on its machine (or gone with it): the record goes. */
export const forget = (sql: SqlClient.SqlClient, key: TerminalKey) =>
  sql`
    DELETE FROM terminal_openings
    WHERE environment_id = ${key.environmentId} AND thread_id = ${key.threadId}
      AND terminal_id = ${key.terminalId}
  `.pipe(Effect.asVoid);
