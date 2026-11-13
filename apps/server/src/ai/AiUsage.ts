/**
 * AI usage (spec 4 ticket 05): each request the gateway layer ends is one `ai_usage` row, added to
 * its `ai_usage_daily` summary by a fiber of its own, off the response's path. Counts only, no
 * quotas. docs: ai-gateway.md, «Usage».
 */
import {
  type AiAccountId,
  type AiAccountProvider,
  AiUsageError,
  type AiUsageErrorReason,
  type AiUsageLabels,
  type AiUsageRow,
  type AiUsageScope,
  type AiUsageSummary,
  type AiUsageSummaryInput,
  type AiUsageTotals,
  type SpaceId,
  type UserId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as AccessPolicy from "../auth/AccessPolicy.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AiGatewayActivity from "./AiGatewayActivity.ts";
import * as AllowedAiAccounts from "./AllowedAiAccounts.ts";

/** Per-request rows are kept this long; the daily summaries are kept for good. */
const AI_USAGE_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
/** The most rows one answer carries (a year of days for a few Users, Spaces and accounts). */
const MAX_ROWS = 5000;
/** The longest window one question may span. */
const MAX_WINDOW_DAYS = 366;
const DEFAULT_WINDOW_DAYS = 30;

export class AiUsage extends Context.Service<
  AiUsage,
  {
    /**
     * Per day, User, Space, AI account and model: the Owner everything; an Organization's Admin
     * their Spaces' (and their own); anyone else only their own usage. A `threadId` reads that
     * Thread's per-request rows, narrowed the same way.
     */
    readonly summary: (input: AiUsageSummaryInput) => Effect.Effect<AiUsageSummary, AiUsageError>;
    /** Deletes per-request rows older than the retention; the summaries stay. Returns how many. */
    readonly sweep: Effect.Effect<number>;
    /** Subscribes now: one outcome for each request written or lost from then on (for tests). */
    readonly outcomes: Effect.Effect<Stream.Stream<AiUsageWriteOutcome>, never, Scope.Scope>;
  }
>()("t3/ai/AiUsage") {}

/** A request the log took in: stored, or lost to a storage failure (logged). */
export interface AiUsageWriteOutcome {
  readonly written: boolean;
}

export interface AiUsageOptions {
  readonly retentionDays: number;
  /** How often the sweep runs (the first run is at start). */
  readonly sweepEveryMs: number;
}

const DEFAULT_OPTIONS: AiUsageOptions = {
  retentionDays: AI_USAGE_RETENTION_DAYS,
  sweepEveryMs: DAY_MS,
};

const fail = (reason: AiUsageErrorReason, message: string) =>
  Effect.fail(new AiUsageError({ reason, message }));

const dayOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis)).slice(0, 10);
/** Midnight UTC of a `YYYY-MM-DD` day; NaN when it is not a date. */
const dayMillis = (day: string) =>
  Option.match(DateTime.make(`${day}T00:00:00.000Z`), {
    onNone: () => Number.NaN,
    onSome: DateTime.toEpochMillis,
  });

interface SummaryRow {
  readonly day: string;
  readonly userId: string;
  readonly spaceId: string;
  readonly accountId: string;
  readonly model: string;
  readonly requests: number;
  readonly failedRequests: number;
  readonly unknownRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

const ZERO_TOTALS: AiUsageTotals = {
  requests: 0,
  failedRequests: 0,
  unknownRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const make = Effect.fn("AiUsage.make")(function* (options: AiUsageOptions) {
  {
    const sql = yield* SqlClient.SqlClient;
    const activity = yield* AiGatewayActivity.AiGatewayActivity;
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    const allowed = yield* AllowedAiAccounts.AllowedAiAccounts;
    const random = yield* SecureRandom.SecureRandom;
    const outcomes = yield* PubSub.unbounded<AiUsageWriteOutcome>();

    const storage = (what: string) => (cause: unknown) =>
      Effect.logError(`AiUsage: could not ${what}`, { cause }).pipe(
        Effect.andThen(fail("storage", `Could not ${what}.`)),
      );

    /**
     * One request: its row and its day's summary in one transaction, so they never disagree.
     * An answer that never finished carries no usage: counted, tokens unknown.
     */
    const write = Effect.fn("AiUsage.write")(function* (
      request: AiGatewayActivity.GatewayRequestRecord,
    ) {
      // Counting tokens is not using a model: it would only add requests without tokens.
      if (request.route.endsWith("/count_tokens")) return;
      const usageId = Buffer.from(yield* random.randomBytes(16)).toString("hex");
      const usage = request.usage;
      const failed = request.status >= 400;
      const unknown = !failed && (usage?.inputTokens ?? usage?.outputTokens ?? null) === null;
      const day = request.at.slice(0, 10);
      const accountId = request.accountId ?? "";
      const model = request.model ?? "";
      const written = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO ai_usage (usage_id, at, day, user_id, space_id, thread_id, key_id,
                account_id, provider, model, shape, status, duration_ms, failovers,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
              VALUES (${usageId}, ${request.at}, ${day}, ${request.userId}, ${request.spaceId},
                ${request.threadId}, ${request.keyId}, ${request.accountId}, ${request.provider},
                ${request.model}, ${request.shape}, ${request.status}, ${request.durationMs},
                ${request.failovers}, ${usage?.inputTokens ?? null}, ${usage?.outputTokens ?? null},
                ${usage?.cacheReadTokens ?? null}, ${usage?.cacheWriteTokens ?? null})
            `;
            yield* sql`
              INSERT INTO ai_usage_daily (day, user_id, space_id, account_id, model, requests,
                failed_requests, unknown_requests, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens)
              VALUES (${day}, ${request.userId}, ${request.spaceId}, ${accountId}, ${model}, 1,
                ${failed ? 1 : 0}, ${unknown ? 1 : 0}, ${usage?.inputTokens ?? 0},
                ${usage?.outputTokens ?? 0}, ${usage?.cacheReadTokens ?? 0},
                ${usage?.cacheWriteTokens ?? 0})
              ON CONFLICT (day, user_id, space_id, account_id, model) DO UPDATE SET
                requests = requests + 1,
                failed_requests = failed_requests + excluded.failed_requests,
                unknown_requests = unknown_requests + excluded.unknown_requests,
                input_tokens = input_tokens + excluded.input_tokens,
                output_tokens = output_tokens + excluded.output_tokens,
                cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
                cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens
            `;
          }),
        )
        .pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("AiUsage: could not record a request's usage", {
              cause,
              route: request.route,
            }).pipe(Effect.as(false)),
          ),
        );
      yield* PubSub.publish(outcomes, { written });
    });

    // Subscribed before this returns: no request that ends after the layer is up is missed. The
    // writer is a fiber of its own, off every response's path.
    const requests = yield* activity.subscribeRequests;
    yield* Stream.runForEach(requests, (request) => write(request).pipe(Effect.ignoreCause)).pipe(
      Effect.forkScoped,
    );

    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cutoff = DateTime.formatIso(DateTime.makeUnsafe(now - options.retentionDays * DAY_MS));
      const removed = yield* sql<{ readonly usageId: string }>`
        DELETE FROM ai_usage WHERE at < ${cutoff} RETURNING usage_id AS "usageId"
      `;
      return removed.length;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiUsage: could not sweep old per-request rows", { cause }).pipe(
          Effect.as(0),
        ),
      ),
      Effect.withSpan("AiUsage.sweep"),
    );
    yield* sweep.pipe(Effect.repeat(Schedule.spaced(options.sweepEveryMs)), Effect.forkScoped);

    const actor = spaces.actingUser.pipe(
      Effect.catchTags({
        SpaceAccessDeniedError: () => fail("forbidden", "Sign in to see AI usage."),
        SpaceDirectoryStorageError: storage("read who you are"),
      }),
      Effect.flatMap(
        Option.match({
          onNone: () => fail("forbidden", "Sign in to see AI usage."),
          onSome: Effect.succeed,
        }),
      ),
    );

    const summary = Effect.fn("AiUsage.summary")(function* (input: AiUsageSummaryInput) {
      const userId = yield* actor;
      const can = yield* spaces
        .authorizer(userId)
        .pipe(Effect.catch(storage("check what you may do")));
      const limit = yield* CommandActor.spaceLimit;

      const now = yield* Clock.currentTimeMillis;
      const toDay = input.toDay ?? dayOf(now);
      const fromDay = input.fromDay ?? dayOf(dayMillis(toDay) - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS);
      if (Number.isNaN(dayMillis(toDay)) || Number.isNaN(dayMillis(fromDay))) {
        return yield* fail("invalid", "Those days are not dates.");
      }
      if (fromDay > toDay) return yield* fail("invalid", "The first day is after the last.");
      if ((dayMillis(toDay) - dayMillis(fromDay)) / DAY_MS >= MAX_WINDOW_DAYS) {
        return yield* fail("invalid", `Ask for at most ${MAX_WINDOW_DAYS} days at a time.`);
      }

      // Who the session may see: the Owner (not limited to one Space) all; others their own, and
      // the whole of each Organization they administer.
      const everything = can("aiAccount.manage", AccessPolicy.installation);
      const sources = input.threadId === undefined ? "ai_usage_daily" : "ai_usage";
      const sourceDays = yield* sql<{ readonly spaceId: string }>`
        SELECT DISTINCT space_id AS "spaceId" FROM ${sql(sources)}
        WHERE day >= ${fromDay} AND day <= ${toDay}
      `.pipe(Effect.catch(storage("read the AI usage")));
      const known = yield* spaces
        .spacesById(sourceDays.map((row) => row.spaceId as SpaceId))
        .pipe(Effect.catch(storage("read your Spaces")));
      const administered = everything
        ? []
        : [...known].flatMap(([spaceId, space]) =>
            can("aiUsage.viewSpace", space.resource) ? [spaceId] : [],
          );
      const scope: AiUsageScope = everything ? "all" : administered.length > 0 ? "spaces" : "own";

      const visible = everything
        ? sql`1 = 1`
        : sql.or([
            limit === undefined
              ? sql`user_id = ${userId}`
              : sql`(user_id = ${userId} AND space_id = ${limit})`,
            ...(administered.length > 0 ? [sql.in("space_id", administered)] : []),
          ]);
      const filters = [
        sql`day >= ${fromDay}`,
        sql`day <= ${toDay}`,
        visible,
        ...(limit === undefined || everything ? [] : [sql`space_id = ${limit}`]),
        ...(input.spaceId === undefined ? [] : [sql`space_id = ${input.spaceId}`]),
        ...(input.userId === undefined ? [] : [sql`user_id = ${input.userId}`]),
        ...(input.accountId === undefined ? [] : [sql`account_id = ${input.accountId}`]),
        ...(input.threadId === undefined ? [] : [sql`thread_id = ${input.threadId}`]),
      ];

      const rows =
        input.threadId === undefined
          ? yield* sql<SummaryRow>`
              SELECT day, user_id AS "userId", space_id AS "spaceId", account_id AS "accountId",
                model, requests, failed_requests AS "failedRequests",
                unknown_requests AS "unknownRequests", input_tokens AS "inputTokens",
                output_tokens AS "outputTokens", cache_read_tokens AS "cacheReadTokens",
                cache_write_tokens AS "cacheWriteTokens"
              FROM ai_usage_daily WHERE ${sql.and(filters)}
              ORDER BY day DESC, space_id, user_id, account_id, model
              LIMIT ${MAX_ROWS + 1}
            `.pipe(Effect.catch(storage("read the AI usage")))
          : yield* sql<SummaryRow>`
              SELECT day, user_id AS "userId", space_id AS "spaceId",
                COALESCE(account_id, '') AS "accountId", COALESCE(model, '') AS "model",
                COUNT(*) AS "requests",
                SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS "failedRequests",
                SUM(CASE WHEN status < 400 AND input_tokens IS NULL AND output_tokens IS NULL
                  THEN 1 ELSE 0 END) AS "unknownRequests",
                COALESCE(SUM(input_tokens), 0) AS "inputTokens",
                COALESCE(SUM(output_tokens), 0) AS "outputTokens",
                COALESCE(SUM(cache_read_tokens), 0) AS "cacheReadTokens",
                COALESCE(SUM(cache_write_tokens), 0) AS "cacheWriteTokens"
              FROM ai_usage WHERE ${sql.and(filters)}
              GROUP BY day, user_id, space_id, COALESCE(account_id, ''), COALESCE(model, '')
              ORDER BY day DESC, space_id, user_id, account_id, model
              LIMIT ${MAX_ROWS + 1}
            `.pipe(Effect.catch(storage("read the AI usage")));
      const truncated = rows.length > MAX_ROWS;
      const kept = truncated ? rows.slice(0, MAX_ROWS) : rows;

      const outRows: Array<AiUsageRow> = kept.map((row) => ({
        day: row.day,
        userId: row.userId as UserId,
        spaceId: row.spaceId as SpaceId,
        accountId: row.accountId === "" ? null : (row.accountId as AiAccountId),
        model: row.model === "" ? null : row.model,
        requests: row.requests,
        failedRequests: row.failedRequests,
        unknownRequests: row.unknownRequests,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
      }));
      const totals = outRows.reduce<AiUsageTotals>(
        (sum, row) => ({
          requests: sum.requests + row.requests,
          failedRequests: sum.failedRequests + row.failedRequests,
          unknownRequests: sum.unknownRequests + row.unknownRequests,
          inputTokens: sum.inputTokens + row.inputTokens,
          outputTokens: sum.outputTokens + row.outputTokens,
          cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
          cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
        }),
        ZERO_TOTALS,
      );

      const labels = yield* labelsOf(userId, everything, outRows);
      return {
        fromDay,
        toDay,
        scope,
        rows: outRows,
        totals,
        labels,
        truncated,
        retentionDays: options.retentionDays,
      } satisfies AiUsageSummary;
    });

    /** Names for what the rows mention; an account's only to those who may know it. */
    const labelsOf = Effect.fn("AiUsage.labelsOf")(function* (
      viewer: UserId,
      everything: boolean,
      rows: ReadonlyArray<AiUsageRow>,
    ) {
      const userIds = [...new Set(rows.map((row) => row.userId))];
      const spaceIds = [...new Set(rows.map((row) => row.spaceId))];
      const accountIds = [
        ...new Set(rows.flatMap((row) => (row.accountId === null ? [] : [row.accountId]))),
      ];
      const users =
        userIds.length === 0
          ? []
          : yield* sql<{ readonly id: string; readonly name: string }>`
              SELECT user_id AS "id", display_name AS "name" FROM users
              WHERE ${sql.in("user_id", userIds)}
            `.pipe(Effect.catch(storage("read the Users")));
      const knownSpaces = yield* spaces
        .spacesById(spaceIds)
        .pipe(Effect.catch(storage("read the Spaces")));
      const accounts =
        accountIds.length === 0
          ? []
          : yield* sql<{
              readonly id: string;
              readonly name: string;
              readonly provider: AiAccountProvider;
            }>`
              SELECT account_id AS "id", name, provider FROM ai_accounts
              WHERE ${sql.in("account_id", accountIds)}
            `.pipe(Effect.catch(storage("read the AI accounts")));
      // Anyone but the Owner learns an account's name only if they may use it somewhere.
      const mayName = new Set<string>();
      if (!everything && accounts.length > 0) {
        const byUse = yield* allowed
          .forSpaces(viewer, spaceIds)
          .pipe(Effect.catch(storage("read the AI accounts you may use")));
        for (const usable of byUse.values()) for (const account of usable) mayName.add(account.id);
      }
      return {
        users: users.map((user) => ({ id: user.id as UserId, name: user.name })),
        spaces: [...knownSpaces].map(([id, space]) => ({ id, name: space.name })),
        accounts: accounts.map((account) => ({
          id: account.id as AiAccountId,
          name: everything || mayName.has(account.id) ? account.name : null,
          provider: account.provider,
        })),
      } satisfies AiUsageLabels;
    });

    return AiUsage.of({
      summary,
      sweep,
      outcomes: Effect.map(PubSub.subscribe(outcomes), Stream.fromSubscription),
    });
  }
});

export const layerWith = (options: AiUsageOptions) => Layer.effect(AiUsage, make(options));
export const layer = layerWith(DEFAULT_OPTIONS);
