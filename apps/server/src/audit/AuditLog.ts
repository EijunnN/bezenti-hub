/**
 * The audit log: who did what in the sensitive actions. Append-only and kept forever (no
 * pruning). `record` joins the caller's transaction when there is one, so an action that rolls
 * back leaves no entry; actions that commit outside this database record right after.
 */
import {
  AUDIT_DETAIL_KEYS,
  type AuditAction,
  type AuditDetailOf,
  type AuditActorSource,
  AuditDetail,
  type AuditEntry,
  type AuditLogPage,
  type AuditLogQuery,
  type AuditTargetKind,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as CommandActor from "../auth/CommandActor.ts";

export type AuditActor =
  | { readonly source: "user"; readonly userId: UserId }
  /** An agent acting as its User; without one, a Thread's agent from before owners: the Owner's. */
  | { readonly source: "agent"; readonly userId?: UserId }
  /** The Hub's shell: `t3 ...` run on the machine, as `--user` when given. */
  | { readonly source: "cli"; readonly userId?: UserId }
  /** The server's own work. */
  | { readonly source: "system" }
  /** A session naming no User: only valid before an Owner exists, refused after. */
  | { readonly source: "unnamed" };

export const userActor = (userId: UserId): AuditActor => ({ source: "user", userId });
export const cliActor: AuditActor = { source: "cli" };

/** Whoever the current fiber acts for, as receipts are stamped. */
export const currentActor: Effect.Effect<AuditActor> = Effect.map(
  CommandActor.resolve,
  (actor): AuditActor => {
    switch (actor._tag) {
      case "Server":
        return actor.via === "cli" ? cliActor : { source: "system" };
      case "User":
        return actor.via === undefined
          ? userActor(actor.userId)
          : { source: actor.via, userId: actor.userId };
      case "ThreadOwner":
        return { source: "agent" };
      case "NoUser":
        return { source: "unnamed" };
    }
  },
);

interface AuditTarget {
  readonly kind: AuditTargetKind;
  readonly id: string;
  /** For a target whose row is already gone; otherwise its current name is kept. */
  readonly name?: string;
}

/** One entry; each action carries only its own detail keys (`AUDIT_DETAIL_KEYS`). */
export type AuditRecord<A extends AuditAction = AuditAction> = A extends AuditAction
  ? {
      readonly actor: AuditActor;
      readonly action: A;
      readonly spaceId?: SpaceId | null;
      readonly target: AuditTarget;
      readonly detail?: AuditDetailOf<A>;
    }
  : never;

/** An entry without its actor, for a writer that records as the fiber's actor. */
export type AuditDraft<A extends AuditAction = AuditAction> = A extends AuditAction
  ? Omit<AuditRecord<A>, "actor">
  : never;

export class AuditLogWriteError extends Schema.TaggedError<AuditLogWriteError>()(
  "AuditLogWriteError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to write the audit log.";
  }
}

export class AuditLogDeniedError extends Schema.TaggedError<AuditLogDeniedError>()(
  "AuditLogDeniedError",
  {},
) {
  override get message(): string {
    return "Only the Owner reads the audit log.";
  }
}

export class AuditLogQueryError extends Schema.TaggedError<AuditLogQueryError>()(
  "AuditLogQueryError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class AuditLogReadError extends Schema.TaggedError<AuditLogReadError>()(
  "AuditLogReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read the audit log.";
  }
}

export class AuditLog extends Context.Service<
  AuditLog,
  {
    readonly record: (entry: AuditRecord) => Effect.Effect<void, AuditLogWriteError>;
    /** Newest first. Only an active Owner reads it; anyone else gets the same refusal. */
    readonly list: (input: {
      readonly viewer: UserId;
      readonly query: AuditLogQuery;
    }) => Effect.Effect<AuditLogPage, AuditLogDeniedError | AuditLogQueryError | AuditLogReadError>;
  }
>()("t3/audit/AuditLog") {}

// Only the keys the action declares survive, whatever a caller passes.
const allowedDetail = (action: AuditAction, detail: object | undefined): AuditDetail => {
  const allowed: ReadonlyArray<string> = AUDIT_DETAIL_KEYS[action];
  return Object.fromEntries(
    Object.entries(detail ?? {}).filter(
      (entry): entry is [string, string | number | boolean | null] =>
        allowed.includes(entry[0]) &&
        (entry[1] === null || ["string", "number", "boolean"].includes(typeof entry[1])),
    ),
  );
};

export class AuditActorMissingError extends Schema.TaggedError<AuditActorMissingError>()(
  "AuditActorMissingError",
  {},
) {
  override get message(): string {
    return "An audited action named no User.";
  }
}

const DetailJson = Schema.fromJsonString(AuditDetail);
const encodeDetail = Schema.encodeEffect(DetailJson);
const decodeDetail = Schema.decodeUnknownOption(DetailJson);

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

/** The insert itself, for a writer that holds its own `SqlClient` (the event sink). */
export const write = (sql: SqlClient.SqlClient) =>
  Effect.fn("AuditLog.write")(function* (entry: AuditRecord) {
    const at = DateTime.formatIso(yield* DateTime.now);
    const { actor } = entry;
    if (actor.source === "unnamed") {
      // Before an Owner exists nobody can be named; after, such a session acts for no one.
      const [owner] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM users WHERE is_owner = 1
      `;
      if ((owner?.count ?? 0) > 0) return yield* new AuditActorMissingError({});
    }
    const source = actor.source === "unnamed" ? "system" : actor.source;
    const userId = "userId" in actor ? (actor.userId ?? null) : null;
    const ownerFallback = actor.source === "agent" && actor.userId === undefined ? 1 : 0;
    const spaceId = entry.spaceId ?? null;
    const { kind, id } = entry.target;
    const detailJson = yield* encodeDetail(allowedDetail(entry.action, entry.detail));
    // A Thread or Project with no Space given is recorded in the Space it belongs to.
    yield* sql`
      INSERT INTO audit_log (
        at, actor_source, actor_user_id, space_id, space_name, action,
        target_kind, target_id, target_name, detail_json
      )
      SELECT
        ${at}, ${source},
        CASE WHEN ${ownerFallback} = 1
          THEN (SELECT user_id FROM users WHERE is_owner = 1) ELSE ${userId} END,
        resolved.space_id,
        (SELECT name FROM spaces WHERE space_id = resolved.space_id), ${entry.action},
        ${kind}, ${id},
        COALESCE(${entry.target.name ?? null}, CASE ${kind}
          WHEN 'user' THEN (SELECT display_name FROM users WHERE user_id = ${id})
          WHEN 'space' THEN (SELECT name FROM spaces WHERE space_id = ${id})
          WHEN 'project' THEN (SELECT title FROM projection_projects WHERE project_id = ${id})
          WHEN 'thread' THEN
            (SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = ${id})
          ELSE NULL END),
        ${detailJson}
      FROM (
        SELECT COALESCE(${spaceId}, CASE ${kind}
          WHEN 'thread' THEN (
            SELECT COALESCE(t.space_id, p.space_id) FROM orchestration_v2_projection_threads AS t
            LEFT JOIN projection_projects AS p ON p.project_id = t.project_id
            WHERE t.thread_id = ${id}
          )
          WHEN 'project' THEN (SELECT space_id FROM projection_projects WHERE project_id = ${id})
          ELSE NULL END) AS space_id
      ) AS resolved
    `;
  });

interface AuditRow {
  readonly id: number;
  readonly at: string;
  readonly actorSource: AuditActorSource;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly spaceId: string | null;
  readonly spaceName: string | null;
  readonly action: AuditAction;
  readonly targetKind: AuditTargetKind;
  readonly targetId: string;
  readonly targetName: string | null;
  readonly detailJson: string;
}

const parseDetail = (json: string): AuditDetail => Option.getOrElse(decodeDetail(json), () => ({}));

const toEntry = (row: AuditRow): AuditEntry => ({
  id: row.id,
  at: DateTime.makeUnsafe(row.at),
  actor: {
    source: row.actorSource,
    userId: row.actorUserId === null ? null : UserId.make(row.actorUserId),
    displayName: row.actorName,
  },
  space: row.spaceId === null ? null : { id: SpaceId.make(row.spaceId), name: row.spaceName },
  action: row.action,
  target: { kind: row.targetKind, id: row.targetId, name: row.targetName },
  detail: parseDetail(row.detailJson),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const insert = write(sql);

  const record: AuditLog["Service"]["record"] = (entry) =>
    insert(entry).pipe(Effect.mapError((cause) => new AuditLogWriteError({ cause })));

  const readError = (cause: unknown) => new AuditLogReadError({ cause });

  const isoDate = (value: string | undefined, name: string) => {
    if (value === undefined) return Effect.succeed(null);
    const parsed = DateTime.make(value);
    return Option.isNone(parsed)
      ? Effect.fail(new AuditLogQueryError({ reason: `${name} is not a date.` }))
      : Effect.succeed(DateTime.formatIso(DateTime.toUtc(parsed.value)));
  };
  const positiveInt = (value: string | undefined, name: string) => {
    if (value === undefined) return Effect.succeed(null);
    return /^[1-9][0-9]{0,15}$/.test(value)
      ? Effect.succeed(Number(value))
      : Effect.fail(new AuditLogQueryError({ reason: `${name} is not a positive number.` }));
  };

  const list: AuditLog["Service"]["list"] = Effect.fn("AuditLog.list")(function* ({
    viewer,
    query,
  }) {
    const [viewerRow] = yield* sql<{ readonly allowed: number }>`
      SELECT is_owner = 1 AND disabled_at IS NULL AND removed_at IS NULL AS allowed
      FROM users WHERE user_id = ${viewer}
    `.pipe(Effect.mapError(readError));
    if (viewerRow?.allowed !== 1) return yield* new AuditLogDeniedError({});
    const from = yield* isoDate(query.from, "from");
    const to = yield* isoDate(query.to, "to");
    const before = yield* positiveInt(query.before, "before");
    const limit = Math.min((yield* positiveInt(query.limit, "limit")) ?? DEFAULT_PAGE, MAX_PAGE);
    const rows = yield* sql<AuditRow>`
      SELECT a.audit_id AS id, a.at, a.actor_source AS "actorSource",
        a.actor_user_id AS "actorUserId", actor.display_name AS "actorName",
        a.space_id AS "spaceId", COALESCE(s.name, a.space_name) AS "spaceName", a.action,
        a.target_kind AS "targetKind", a.target_id AS "targetId",
        COALESCE(target_user.display_name, target_space.name, a.target_name) AS "targetName",
        a.detail_json AS "detailJson"
      FROM audit_log AS a
      LEFT JOIN users AS actor ON actor.user_id = a.actor_user_id
      LEFT JOIN spaces AS s ON s.space_id = a.space_id
      LEFT JOIN users AS target_user
        ON a.target_kind = 'user' AND target_user.user_id = a.target_id
      LEFT JOIN spaces AS target_space
        ON a.target_kind = 'space' AND target_space.space_id = a.target_id
      WHERE ${sql.and([
        ...(query.action === undefined ? [] : [sql`a.action = ${query.action}`]),
        ...(query.actorUserId === undefined ? [] : [sql`a.actor_user_id = ${query.actorUserId}`]),
        ...(query.spaceId === undefined ? [] : [sql`a.space_id = ${query.spaceId}`]),
        ...(from === null ? [] : [sql`a.at >= ${from}`]),
        ...(to === null ? [] : [sql`a.at < ${to}`]),
        ...(before === null ? [] : [sql`a.audit_id < ${before}`]),
      ])}
      ORDER BY a.audit_id DESC
      LIMIT ${limit + 1}
    `.pipe(Effect.mapError(readError));
    const page = rows.slice(0, limit);
    // Deleted Organizations too, named as they were, so the Owner can still filter by them.
    const spaces = yield* sql<{
      readonly id: string;
      readonly name: string | null;
      readonly deleted: number;
    }>`
      SELECT a.space_id AS id, COALESCE(s.name, MAX(a.space_name)) AS name,
        s.space_id IS NULL AS deleted
      FROM audit_log AS a LEFT JOIN spaces AS s ON s.space_id = a.space_id
      WHERE a.space_id IS NOT NULL
      GROUP BY a.space_id ORDER BY name
    `.pipe(Effect.mapError(readError));
    return {
      entries: page.map(toEntry),
      spaces: spaces.map((space) => ({
        id: SpaceId.make(space.id),
        name: space.name,
        deleted: space.deleted === 1,
      })),
      nextCursor: rows.length > limit ? String(page.at(-1)!.id) : null,
    };
  });

  return AuditLog.of({ record, list });
});

export const layer = Layer.effect(AuditLog, make);
