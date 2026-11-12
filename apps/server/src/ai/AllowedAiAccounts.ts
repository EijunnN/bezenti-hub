/**
 * The one rule of which AI accounts a User may use in a Space: enabled accounts allowed to the
 * Space or to the User, and none unless the User may work there (AccessPolicy `aiAccount.use`).
 * Evaluated on every call, never cached; the gateway, picker and move plan all ask here.
 */
import type {
  AiAccountId,
  AiAccountProvider,
  AiAccountType,
  SpaceId,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";

/** An AI account a User may use in a Space, first to last by the Installation's priority. */
export interface AllowedAiAccount {
  readonly id: AiAccountId;
  readonly name: string;
  readonly type: AiAccountType;
  readonly provider: AiAccountProvider;
  readonly priority: number;
}

export class AllowedAiAccountsError extends Schema.TaggedError<AllowedAiAccountsError>()(
  "AllowedAiAccountsError",
  { message: Schema.String },
) {}

export class AllowedAiAccounts extends Context.Service<
  AllowedAiAccounts,
  {
    /** `AllowedAiAccounts.for(userId, spaceId)`: empty when the User does not work there. */
    readonly for: (
      userId: UserId,
      spaceId: SpaceId,
    ) => Effect.Effect<ReadonlyArray<AllowedAiAccount>, AllowedAiAccountsError>;
    /** The same rule for several Spaces at once, one answer per Space asked about. */
    readonly forSpaces: (
      userId: UserId,
      spaceIds: ReadonlyArray<SpaceId>,
    ) => Effect.Effect<
      ReadonlyMap<SpaceId, ReadonlyArray<AllowedAiAccount>>,
      AllowedAiAccountsError
    >;
  }
>()("t3/ai/AllowedAiAccounts") {}

interface AllowedRow {
  readonly accountId: string;
  readonly name: string;
  readonly type: AiAccountType;
  readonly provider: AiAccountProvider;
  readonly priority: number;
  readonly subjectKind: "space" | "user";
  readonly subjectId: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const spaces = yield* SpaceDirectory.SpaceDirectory;

  const failed = (what: string) => (cause: unknown) =>
    Effect.logError(`AllowedAiAccounts: could not ${what}`, { cause }).pipe(
      Effect.andThen(Effect.fail(new AllowedAiAccountsError({ message: `Could not ${what}.` }))),
    );

  const forSpaces = Effect.fn("AllowedAiAccounts.forSpaces")(function* (
    userId: UserId,
    spaceIds: ReadonlyArray<SpaceId>,
  ) {
    const answer = new Map<SpaceId, ReadonlyArray<AllowedAiAccount>>();
    const asked = [...new Set(spaceIds)];
    for (const spaceId of asked) answer.set(spaceId, []);
    if (asked.length === 0) return answer;
    const principal = yield* spaces
      .principalOf(userId)
      .pipe(Effect.catch(failed("read who the User is")));
    const known = yield* spaces.spacesById(asked).pipe(Effect.catch(failed("read the Spaces")));
    // Only the Spaces the User works in: elsewhere nothing, not even what is allowed to them.
    const working = asked.filter((spaceId) => {
      const space = known.get(spaceId);
      return (
        space !== undefined &&
        AccessPolicy.isAllowed(AccessPolicy.decide(principal, "aiAccount.use", space.resource))
      );
    });
    if (working.length === 0) return answer;
    const rows = yield* sql<AllowedRow>`
      SELECT a.account_id AS "accountId", a.name AS "name", a.type AS "type",
        a.provider AS "provider", a.priority AS "priority",
        l.subject_kind AS "subjectKind", l.subject_id AS "subjectId"
      FROM ai_accounts a
      JOIN ai_account_allowances l ON l.account_id = a.account_id
      WHERE a.disabled = 0 AND (
        (l.subject_kind = 'user' AND l.subject_id = ${userId})
        OR (l.subject_kind = 'space' AND ${sql.in("l.subject_id", working)})
      )
      ORDER BY a.priority, a.account_id
    `.pipe(Effect.catch(failed("read the AI accounts")));
    for (const spaceId of working) {
      const seen = new Set<string>();
      const accounts: Array<AllowedAiAccount> = [];
      for (const row of rows) {
        const applies =
          row.subjectKind === "user" ? row.subjectId === userId : row.subjectId === spaceId;
        if (!applies || seen.has(row.accountId)) continue;
        seen.add(row.accountId);
        accounts.push({
          id: row.accountId as AiAccountId,
          name: row.name,
          type: row.type,
          provider: row.provider,
          priority: row.priority,
        });
      }
      answer.set(spaceId, accounts);
    }
    return answer;
  });

  return AllowedAiAccounts.of({
    for: Effect.fn("AllowedAiAccounts.for")(function* (userId: UserId, spaceId: SpaceId) {
      const answer = yield* forSpaces(userId, [spaceId]);
      return answer.get(spaceId) ?? [];
    }),
    forSpaces,
  });
});

export const layer = Layer.effect(AllowedAiAccounts, make);
