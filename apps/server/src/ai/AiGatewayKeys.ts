// @effect-diagnostics nodeBuiltinImport:off -- random keys and their SHA-256, synchronous and small.
/**
 * Gateway keys (spec 4 ticket 04) and the one check of an `/api/ai/*` request (`authorize`): the
 * key, its User, its Thread's Space and owner, and AllowedAiAccounts, all read again per request.
 * Keys are random (`t3gk_` + 32 bytes), kept only as SHA-256. docs/internals/ai-gateway.md.
 */
import * as NodeCrypto from "node:crypto";

import {
  AI_GATEWAY_KEY_PREFIX,
  type AiAccountId,
  type AiGatewayKeyKind,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AccessPolicy from "../auth/AccessPolicy.ts";
import { threadTurnOwner } from "../orchestration-v2/threadTurnOwner.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";
import { isGatewayKeyShaped } from "./gatewayShapes.ts";

/** Why a request's key gets nothing: 401 (no such live key), 403 (not here), 503 (try later). */
export class AiGatewayRefusal extends Schema.TaggedError<AiGatewayRefusal>()("AiGatewayRefusal", {
  status: Schema.Literals([401, 403, 503]),
  message: Schema.String,
}) {}

/** Why making or revoking a key failed, in words for its User. */
export class AiGatewayKeyError extends Schema.TaggedError<AiGatewayKeyError>()(
  "AiGatewayKeyError",
  {
    reason: Schema.Literals(["forbidden", "not-found", "invalid", "limit", "storage"]),
    message: Schema.String,
  },
) {}

/** Who a request is, decided on the Hub from its key alone, and what it may reach right now. */
export interface GatewayCaller {
  readonly keyId: string;
  readonly kind: AiGatewayKeyKind;
  readonly userId: UserId;
  readonly spaceId: SpaceId;
  readonly threadId: ThreadId | null;
  /** AllowedAiAccounts for (User, Space) now, through the gateway only (no direct credential). */
  readonly allowed: ReadonlyArray<AllowedAiAccounts.AllowedAiAccount>;
  /** The Thread's own AI account (its model selection), if it chose one. */
  readonly chosenAccountId: AiAccountId | null;
}

/** A key just made: shown once, never stored. */
export interface IssuedGatewayKey {
  readonly keyId: string;
  readonly key: Redacted.Redacted<string>;
}

/** A User key as its User sees it: never the key, nor its hash. */
export interface GatewayKeySummary {
  readonly keyId: string;
  readonly name: string;
  readonly userId: UserId;
  readonly spaceId: SpaceId;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
}

export class AiGatewayKeys extends Context.Service<
  AiGatewayKeys,
  {
    /**
     * A new key for a Thread's provider session (ticket 06 hands it to the agent): for the
     * Thread's turn owner in its Space now. Earlier keys of the Thread are revoked (one live key
     * per Thread, rotated at each session).
     */
    readonly issueForThread: (
      threadId: ThreadId,
      options?: { readonly providerSessionId?: string },
    ) => Effect.Effect<IssuedGatewayKey, AiGatewayKeyError>;
    /** Revokes every live key of a Thread (moved, archived, deleted). */
    readonly revokeThread: (
      threadId: ThreadId,
      reason: string,
    ) => Effect.Effect<void, AiGatewayKeyError>;
    /** Revokes the keys issued for one provider session (of one Thread, when it detaches). */
    readonly revokeSession: (
      providerSessionId: string,
      reason: string,
      threadId?: ThreadId,
    ) => Effect.Effect<void, AiGatewayKeyError>;
    /** Revokes every live Thread key: at a Hub start no provider session of them is alive. */
    readonly revokeLiveThreadKeys: (reason: string) => Effect.Effect<void, AiGatewayKeyError>;
    /** Revokes every key of a User (disabled or removed). */
    readonly revokeUser: (userId: UserId, reason: string) => Effect.Effect<void, AiGatewayKeyError>;
    /** A User's key for a local CLI, in a Space they work in (ticket 10 gives it a screen). */
    readonly createForUser: (input: {
      readonly actorUserId: UserId;
      readonly spaceId: SpaceId;
      readonly name: string;
    }) => Effect.Effect<IssuedGatewayKey, AiGatewayKeyError>;
    /** The actor's own User keys; the Owner's lists everyone's. */
    readonly listUserKeys: (
      actorUserId: UserId,
    ) => Effect.Effect<ReadonlyArray<GatewayKeySummary>, AiGatewayKeyError>;
    /** Revokes a User key: its User's own, or any for the Owner. */
    readonly revoke: (input: {
      readonly actorUserId: UserId;
      readonly keyId: string;
    }) => Effect.Effect<void, AiGatewayKeyError>;
    /** The one check of a request: who it is and what it may reach, now. */
    readonly authorize: (
      key: Redacted.Redacted<string>,
    ) => Effect.Effect<GatewayCaller, AiGatewayRefusal>;
  }
>()("t3/ai/AiGatewayKeys") {}

/** A Thread key lives until its session's next one replaces it, or a week at most. */
const THREAD_KEY_LIFETIME_DAYS = 7;
/** Live User keys one User may hold (local CLIs). */
const MAX_USER_KEYS = 5;
const MAX_NAME_LENGTH = 80;

/** The only form a key is kept in: its SHA-256, hex. */
const gatewayKeyHash = (key: string) =>
  NodeCrypto.createHash("sha256").update(key, "utf8").digest("hex");

const newKey = () => `${AI_GATEWAY_KEY_PREFIX}${NodeCrypto.randomBytes(32).toString("base64url")}`;
const newKeyId = () => `gk_${NodeCrypto.randomBytes(12).toString("hex")}`;

interface KeyRow {
  readonly keyId: string;
  readonly kind: AiGatewayKeyKind;
  readonly userId: string;
  readonly spaceId: string;
  readonly threadId: string | null;
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

const KEY_COLUMNS = `key_id AS "keyId", kind, user_id AS "userId", space_id AS "spaceId",
  thread_id AS "threadId", name, created_at AS "createdAt", expires_at AS "expiresAt",
  last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"`;

const UNKNOWN_KEY = "This AI gateway key is not valid. It may have been revoked or expired.";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const allowedAccounts = yield* AllowedAiAccounts.AllowedAiAccounts;
  const audit = yield* AuditLog.AuditLog;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const storage = (what: string) => (cause: unknown) =>
    Effect.logError(`AiGatewayKeys: could not ${what}`, { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new AiGatewayKeyError({ reason: "storage", message: `Could not ${what}. Try again.` }),
        ),
      ),
    );

  const refused = (status: 401 | 403 | 503, message: string) =>
    Effect.fail(new AiGatewayRefusal({ status, message }));

  /** Whether the User may work in the Space: the rule AllowedAiAccounts applies. */
  const worksIn = Effect.fn("AiGatewayKeys.worksIn")(function* (userId: UserId, spaceId: SpaceId) {
    const principal = yield* spaces.principalOf(userId);
    const space = yield* spaces.spaceById(spaceId);
    return (
      Option.isSome(space) &&
      AccessPolicy.isAllowed(AccessPolicy.decide(principal, "aiAccount.use", space.value.resource))
    );
  });

  const revokeThread = Effect.fn("AiGatewayKeys.revokeThread")(function* (
    threadId: ThreadId,
    reason: string,
  ) {
    const at = yield* nowIso;
    yield* sql`
      UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = ${reason}
      WHERE thread_id = ${threadId} AND revoked_at IS NULL
    `.pipe(Effect.catch(storage("revoke the Thread's AI gateway keys")));
  });

  const revokeSession = Effect.fn("AiGatewayKeys.revokeSession")(function* (
    providerSessionId: string,
    reason: string,
    threadId?: ThreadId,
  ) {
    const at = yield* nowIso;
    yield* sql`
      UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = ${reason}
      WHERE provider_session_id = ${providerSessionId} AND revoked_at IS NULL
        AND ${threadId === undefined ? sql`1 = 1` : sql`thread_id = ${threadId}`}
    `.pipe(Effect.catch(storage("revoke the session's AI gateway keys")));
  });

  const revokeLiveThreadKeys = Effect.fn("AiGatewayKeys.revokeLiveThreadKeys")(function* (
    reason: string,
  ) {
    const at = yield* nowIso;
    yield* sql`
      UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = ${reason}
      WHERE kind = 'thread' AND revoked_at IS NULL
    `.pipe(Effect.catch(storage("revoke the earlier sessions' AI gateway keys")));
  });

  const revokeUser = Effect.fn("AiGatewayKeys.revokeUser")(function* (
    userId: UserId,
    reason: string,
  ) {
    const at = yield* nowIso;
    yield* sql`
      UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = ${reason}
      WHERE user_id = ${userId} AND revoked_at IS NULL
    `.pipe(Effect.catch(storage("revoke the User's AI gateway keys")));
  });

  const issueForThread = Effect.fn("AiGatewayKeys.issueForThread")(function* (
    threadId: ThreadId,
    options: { readonly providerSessionId?: string } = {},
  ) {
    const space = yield* spaces
      .spaceOf({ kind: "thread", id: threadId })
      .pipe(Effect.catch(storage("read the Thread's Space")));
    const owner = yield* threadTurnOwner(sql, threadId).pipe(
      Effect.catch(storage("read who owns the Thread")),
    );
    if (Option.isNone(space) || Option.isNone(owner)) {
      return yield* new AiGatewayKeyError({ reason: "not-found", message: "No such Thread." });
    }
    const key = newKey();
    const keyId = newKeyId();
    const now = yield* DateTime.now;
    const at = DateTime.formatIso(now);
    const expiresAt = DateTime.formatIso(DateTime.add(now, { days: THREAD_KEY_LIFETIME_DAYS }));
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = 'rotated'
            WHERE thread_id = ${threadId} AND revoked_at IS NULL
          `;
          yield* sql`
            INSERT INTO ai_gateway_keys (key_id, key_hash, kind, user_id, space_id, thread_id,
              provider_session_id, name, created_at, expires_at)
            VALUES (${keyId}, ${gatewayKeyHash(key)}, 'thread', ${owner.value}, ${space.value.id},
              ${threadId}, ${options.providerSessionId ?? null}, ${`Thread ${threadId}`}, ${at},
              ${expiresAt})
          `;
        }),
      )
      .pipe(Effect.catch(storage("issue the Thread's AI gateway key")));
    return { keyId, key: Redacted.make(key) } satisfies IssuedGatewayKey;
  });

  const createForUser = Effect.fn("AiGatewayKeys.createForUser")(function* (input: {
    readonly actorUserId: UserId;
    readonly spaceId: SpaceId;
    readonly name: string;
  }) {
    const name = input.name.trim();
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      return yield* new AiGatewayKeyError({
        reason: "invalid",
        message: `Name the key (up to ${MAX_NAME_LENGTH} characters).`,
      });
    }
    const works = yield* worksIn(input.actorUserId, input.spaceId).pipe(
      Effect.catch(storage("check the Space")),
    );
    if (!works) {
      return yield* new AiGatewayKeyError({
        reason: "forbidden",
        message: "You can make a key only for a Space you work in.",
      });
    }
    const key = newKey();
    const keyId = newKeyId();
    const at = yield* nowIso;
    const made = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const live = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM ai_gateway_keys
            WHERE kind = 'user' AND user_id = ${input.actorUserId} AND revoked_at IS NULL
          `;
          if ((live[0]?.n ?? 0) >= MAX_USER_KEYS) return false;
          yield* sql`
            INSERT INTO ai_gateway_keys (key_id, key_hash, kind, user_id, space_id, thread_id,
              name, created_at)
            VALUES (${keyId}, ${gatewayKeyHash(key)}, 'user', ${input.actorUserId},
              ${input.spaceId}, NULL, ${name}, ${at})
          `;
          yield* audit.record({
            actor: AuditLog.userActor(input.actorUserId),
            action: "ai_gateway_key.create",
            target: { kind: "ai_gateway_key", id: keyId, name },
            detail: { kind: "user", space: input.spaceId },
          });
          return true;
        }),
      )
      .pipe(Effect.catch(storage("make the AI gateway key")));
    if (!made) {
      return yield* new AiGatewayKeyError({
        reason: "limit",
        message: `You have ${MAX_USER_KEYS} keys already. Revoke one to make another.`,
      });
    }
    return { keyId, key: Redacted.make(key) } satisfies IssuedGatewayKey;
  });

  const listUserKeys = Effect.fn("AiGatewayKeys.listUserKeys")(function* (actorUserId: UserId) {
    const principal = yield* spaces
      .principalOf(actorUserId)
      .pipe(Effect.catch(storage("read who you are")));
    const rows = yield* (
      principal.isOwner
        ? sql<KeyRow>`SELECT ${sql.literal(KEY_COLUMNS)} FROM ai_gateway_keys
            WHERE kind = 'user' AND revoked_at IS NULL ORDER BY created_at`
        : sql<KeyRow>`SELECT ${sql.literal(KEY_COLUMNS)} FROM ai_gateway_keys
            WHERE kind = 'user' AND revoked_at IS NULL AND user_id = ${actorUserId}
            ORDER BY created_at`
    ).pipe(Effect.catch(storage("list the AI gateway keys")));
    return rows.map((row): GatewayKeySummary => ({
      keyId: row.keyId,
      name: row.name,
      userId: UserId.make(row.userId),
      spaceId: SpaceId.make(row.spaceId),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
    }));
  });

  const revoke = Effect.fn("AiGatewayKeys.revoke")(function* (input: {
    readonly actorUserId: UserId;
    readonly keyId: string;
  }) {
    const rows = yield* sql<KeyRow>`
      SELECT ${sql.literal(KEY_COLUMNS)} FROM ai_gateway_keys WHERE key_id = ${input.keyId}
    `.pipe(Effect.catch(storage("read the AI gateway key")));
    const row = rows[0];
    const principal = yield* spaces
      .principalOf(input.actorUserId)
      .pipe(Effect.catch(storage("read who you are")));
    // Someone else's key answers like a missing one.
    if (
      row === undefined ||
      row.kind !== "user" ||
      (row.userId !== input.actorUserId && !principal.isOwner)
    ) {
      return yield* new AiGatewayKeyError({ reason: "not-found", message: "No such key." });
    }
    if (row.revokedAt !== null) return;
    const at = yield* nowIso;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = 'revoked'
            WHERE key_id = ${row.keyId} AND revoked_at IS NULL
          `;
          yield* audit.record({
            actor: AuditLog.userActor(input.actorUserId),
            action: "ai_gateway_key.revoke",
            target: { kind: "ai_gateway_key", id: row.keyId, name: row.name },
            detail: { kind: row.kind, space: row.spaceId, reason: "revoked" },
          });
        }),
      )
      .pipe(Effect.catch(storage("revoke the AI gateway key")));
  });

  const unavailable = (cause: unknown) =>
    Effect.logError("AiGatewayKeys: could not check a request", { cause }).pipe(
      Effect.andThen(refused(503, "The AI gateway could not check this key. Try again.")),
    );

  const authorize = Effect.fn("AiGatewayKeys.authorize")(function* (
    key: Redacted.Redacted<string>,
  ) {
    const raw = Redacted.value(key);
    if (!isGatewayKeyShaped(raw)) return yield* refused(401, UNKNOWN_KEY);
    // One read: the key, its User's state and, for a Thread key, the Thread.
    const rows = yield* sql<
      KeyRow & {
        readonly userStatus: "active" | "inactive" | "missing";
        readonly threadFound: number;
        readonly archivedAt: string | null;
        readonly deletedAt: string | null;
        readonly chosen: string | null;
      }
    >`
      SELECT k.key_id AS "keyId", k.kind AS "kind", k.user_id AS "userId",
        k.space_id AS "spaceId", k.thread_id AS "threadId", k.name AS "name",
        k.created_at AS "createdAt", k.expires_at AS "expiresAt",
        k.last_used_at AS "lastUsedAt", k.revoked_at AS "revokedAt",
        CASE WHEN u.user_id IS NULL THEN 'missing'
          WHEN u.disabled_at IS NOT NULL OR u.removed_at IS NOT NULL THEN 'inactive'
          ELSE 'active' END AS "userStatus",
        t.thread_id IS NOT NULL AS "threadFound", t.archived_at AS "archivedAt",
        t.deleted_at AS "deletedAt",
        json_extract(t.payload_json, '$.modelSelection.aiAccountId') AS "chosen"
      FROM ai_gateway_keys k
      LEFT JOIN users u ON u.user_id = k.user_id
      LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = k.thread_id
      WHERE k.key_hash = ${gatewayKeyHash(raw)}
    `.pipe(Effect.catch(unavailable));
    const row = rows[0];
    if (row === undefined || row.revokedAt !== null) return yield* refused(401, UNKNOWN_KEY);
    const now = yield* DateTime.now;
    if (row.expiresAt !== null && Date.parse(row.expiresAt) <= DateTime.toEpochMillis(now)) {
      return yield* refused(401, UNKNOWN_KEY);
    }
    const userId = UserId.make(row.userId);
    const spaceId = SpaceId.make(row.spaceId);
    // A User removed, disabled or gone: none of their keys work, whatever they are for.
    if (row.userStatus !== "active") return yield* refused(401, UNKNOWN_KEY);
    let threadId: ThreadId | null = null;
    let chosenAccountId: AiAccountId | null = null;
    if (row.kind === "thread") {
      threadId = ThreadId.make(row.threadId ?? "");
      if (!row.threadFound || row.deletedAt !== null || row.archivedAt !== null) {
        return yield* refused(401, UNKNOWN_KEY);
      }
      // The Thread's Space now (SpaceDirectory's rule), its turn owner and any move, at once.
      const [space, owner, blocked] = yield* Effect.all(
        [
          spaces.spaceOf({ kind: "thread", id: threadId }),
          threadTurnOwner(sql, threadId),
          spaces.workBlocked(threadId),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.catch(unavailable));
      // Moved or handed over: the key is over for good, and its row says so.
      const over = (reason: string, message: string) =>
        nowIso.pipe(
          Effect.flatMap(
            (at) => sql`
              UPDATE ai_gateway_keys SET revoked_at = ${at}, revoked_reason = ${reason}
              WHERE key_id = ${row.keyId} AND revoked_at IS NULL
            `,
          ),
          Effect.ignore,
          Effect.andThen(refused(403, message)),
        );
      if (Option.isNone(space) || space.value.id !== spaceId) {
        return yield* over(
          "thread-moved",
          "This Thread is in another Space now; its key no longer works.",
        );
      }
      // The key acts for the Thread's turn owner only: another owner, another key.
      if (Option.isNone(owner) || owner.value !== userId) {
        return yield* over("owner-changed", "This key is not for this Thread's owner.");
      }
      if (blocked === "project-moving") {
        return yield* refused(503, "The Project is moving to another Space. Try again.");
      }
      chosenAccountId = (row.chosen ?? null) as AiAccountId | null;
    }
    // Evaluated now, never cached: an allowance removed a moment ago is gone here.
    const allowed = (yield* allowedAccounts
      .for(userId, spaceId)
      .pipe(Effect.catch(unavailable))).filter((account) => account.type !== "direct");
    if (allowed.length === 0) {
      return yield* refused(403, "No AI account is allowed to you in this Space.");
    }
    // `last_used_at` is written at most once a minute per key.
    const at = DateTime.formatIso(now);
    const stale = DateTime.formatIso(DateTime.subtract(now, { minutes: 1 }));
    yield* sql`
      UPDATE ai_gateway_keys SET last_used_at = ${at}
      WHERE key_id = ${row.keyId} AND (last_used_at IS NULL OR last_used_at < ${stale})
    `.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiGatewayKeys: could not note a key's last use", { cause }),
      ),
    );
    return {
      keyId: row.keyId,
      kind: row.kind,
      userId,
      spaceId,
      threadId,
      allowed,
      chosenAccountId,
    } satisfies GatewayCaller;
  });

  return AiGatewayKeys.of({
    issueForThread,
    revokeLiveThreadKeys,
    revokeThread,
    revokeSession,
    revokeUser,
    createForUser,
    listUserKeys,
    revoke,
    authorize,
  });
});

export const layer = Layer.effect(AiGatewayKeys, make);
