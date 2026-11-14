/**
 * Spec 4 ticket 11: what a removal drops of the AI accounts, in the removal's own transaction:
 * the gateway keys it ends and the allowances that name what is gone, each audited. The request
 * check (`AiGatewayKeys.authorize`) refuses them anyway; this keeps the record true at once.
 */
import type { SpaceId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import * as AuditLog from "../audit/AuditLog.ts";
import * as AiGatewayKeys from "./AiGatewayKeys.ts";

/**
 * Drops every allowance to these subjects, each account's audited `ai_account.allow` with what
 * it still has and what it lost. Run inside the removal's own transaction.
 */
const dropAllowances = Effect.fn("AiAccountReachLoss.dropAllowances")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  subjects: ReadonlyArray<{ readonly kind: "user" | "space"; readonly id: string }>,
) {
  if (subjects.length === 0) return;
  const matches = sql.or(
    subjects.map((subject) => sql`(subject_kind = ${subject.kind} AND subject_id = ${subject.id})`),
  );
  const dropped = yield* sql<{ readonly accountId: string }>`
    DELETE FROM ai_account_allowances WHERE ${matches} RETURNING account_id AS "accountId"
  `;
  const byAccount = new Map<string, number>();
  for (const row of dropped) byAccount.set(row.accountId, (byAccount.get(row.accountId) ?? 0) + 1);
  if (byAccount.size === 0) return;
  const accounts = yield* sql<{
    readonly accountId: string;
    readonly name: string;
    readonly spaces: number;
    readonly users: number;
  }>`
    SELECT a.account_id AS "accountId", a.name AS "name",
      (SELECT COUNT(*) FROM ai_account_allowances l
        WHERE l.account_id = a.account_id AND l.subject_kind = 'space') AS "spaces",
      (SELECT COUNT(*) FROM ai_account_allowances l
        WHERE l.account_id = a.account_id AND l.subject_kind = 'user') AS "users"
    FROM ai_accounts a WHERE ${sql.in("a.account_id", [...byAccount.keys()])}
  `;
  const write = AuditLog.write(sql);
  for (const account of accounts) {
    yield* write({
      actor,
      action: "ai_account.allow",
      target: { kind: "ai_account", id: account.accountId, name: account.name },
      detail: {
        spaces: account.spaces,
        users: account.users,
        added: 0,
        removed: byAccount.get(account.accountId) ?? 0,
      },
    });
  }
});

/**
 * A User removed from the Installation (inside `InstallationUserService`'s transaction): every
 * key of theirs revoked (`user-inactive`), every allowance to them and to their frozen Personal
 * space dropped. Their Threads' choices stay: nobody runs their turns any more.
 */
export const forgetUser = Effect.fn("AiAccountReachLoss.forgetUser")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  userId: UserId,
) {
  yield* AiGatewayKeys.revokeWithin(sql, actor, { userId }, "user-inactive");
  yield* dropAllowances(sql, actor, [
    { kind: "user", id: userId },
    { kind: "space", id: `personal:${userId}` },
  ]);
});

/**
 * An Organization deleted (inside `OrganizationLifecycle.delete`'s transaction, its Threads
 * already gone): the keys made for its Space revoked (`space-lost`), its allowances dropped.
 */
export const forgetSpace = Effect.fn("AiAccountReachLoss.forgetSpace")(function* (
  sql: SqlClient.SqlClient,
  actor: AuditLog.AuditActor,
  spaceId: SpaceId,
) {
  yield* AiGatewayKeys.revokeWithin(sql, actor, { spaceId }, "space-lost");
  yield* dropAllowances(sql, actor, [{ kind: "space", id: spaceId }]);
});
