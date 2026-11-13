/**
 * What the AI gateway layer did (spec 4 ticket 04): one record per request, which ticket 05 turns
 * into usage rows (`subscribeRequests`), and the AI account each Thread's requests last went
 * to, kept and published when it changes (a failover, a switch) so the Thread's header shows the
 * account in use (decision 7). Never a key, a header or a prompt.
 */
import type {
  AiAccountId,
  AiAccountProvider,
  AiGatewayKeyKind,
  SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import type { GatewayShape, GatewayUsage } from "./gatewayShapes.ts";

/** One request through `/api/ai/*`, as far as the Hub knows when it ends. */
export interface GatewayRequestRecord {
  readonly at: string;
  readonly keyId: string;
  readonly keyKind: AiGatewayKeyKind;
  readonly userId: UserId;
  readonly spaceId: SpaceId;
  readonly threadId: ThreadId | null;
  readonly shape: GatewayShape;
  readonly route: string;
  /** The account that answered, after any failover; null when none was reached. */
  readonly accountId: AiAccountId | null;
  readonly provider: AiAccountProvider | null;
  readonly model: string | null;
  readonly status: number;
  readonly durationMs: number;
  /** Accounts tried before the one that answered (each out of quota). */
  readonly failovers: number;
  /** Null when the answer never finished (cut off, failed). */
  readonly usage: GatewayUsage | null;
  /** A request refused for load (a limit): counted in the daily summary, never as its own row. */
  readonly shed?: true;
}

/** The AI account a Thread's requests go to now. */
export interface AccountInUse {
  readonly threadId: ThreadId;
  readonly accountId: AiAccountId;
  readonly model: string;
}

export class AiGatewayActivity extends Context.Service<
  AiGatewayActivity,
  {
    /** Called once per request when it ends; ticket 05 counts usage from these. */
    readonly record: (request: GatewayRequestRecord) => Effect.Effect<void>;
    /** Subscribes now (nothing recorded after it returns is missed): every request from now on. */
    readonly subscribeRequests: Effect.Effect<
      Stream.Stream<GatewayRequestRecord>,
      never,
      Scope.Scope
    >;
    /** Notes the account a Thread's request went to; publishes it when it changed. */
    readonly noteInUse: (use: AccountInUse) => Effect.Effect<void>;
    /** Subscribes now: each change of a Thread's account in use from then on. */
    readonly subscribeAccountsInUse: Effect.Effect<Stream.Stream<AccountInUse>, never, Scope.Scope>;
    /** The account a Thread's requests went to last. */
    readonly inUse: (threadId: ThreadId) => Effect.Effect<Option.Option<AccountInUse>>;
    /** Forgets a deleted Thread's account in use. */
    readonly forgetThread: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/ai/AiGatewayActivity") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const requests = yield* PubSub.unbounded<GatewayRequestRecord>();
  const changes = yield* PubSub.unbounded<AccountInUse>();

  const inUse = Effect.fn("AiGatewayActivity.inUse")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ readonly accountId: string; readonly model: string }>`
      SELECT account_id AS "accountId", model FROM ai_gateway_thread_accounts
      WHERE thread_id = ${threadId}
    `.pipe(Effect.orElseSucceed(() => []));
    const row = rows[0];
    return row === undefined
      ? Option.none<AccountInUse>()
      : Option.some<AccountInUse>({
          threadId,
          accountId: row.accountId as AiAccountId,
          model: row.model,
        });
  });

  const noteInUse = Effect.fn("AiGatewayActivity.noteInUse")(function* (use: AccountInUse) {
    const before = yield* inUse(use.threadId);
    if (
      Option.isSome(before) &&
      before.value.accountId === use.accountId &&
      before.value.model === use.model
    ) {
      return;
    }
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO ai_gateway_thread_accounts (thread_id, account_id, model, updated_at)
      VALUES (${use.threadId}, ${use.accountId}, ${use.model}, ${at})
      ON CONFLICT (thread_id) DO UPDATE SET account_id = excluded.account_id,
        model = excluded.model, updated_at = excluded.updated_at
    `.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("AiGatewayActivity: could not note a Thread's AI account", { cause }),
      ),
    );
    yield* PubSub.publish(changes, use);
  });

  return AiGatewayActivity.of({
    record: Effect.fn("AiGatewayActivity.record")(function* (request: GatewayRequestRecord) {
      yield* PubSub.publish(requests, request);
    }),
    subscribeRequests: Effect.map(PubSub.subscribe(requests), Stream.fromSubscription),
    noteInUse,
    subscribeAccountsInUse: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
    inUse,
    forgetThread: Effect.fn("AiGatewayActivity.forgetThread")(function* (threadId: ThreadId) {
      yield* sql`DELETE FROM ai_gateway_thread_accounts WHERE thread_id = ${threadId}`.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("AiGatewayActivity: could not forget a Thread's AI account", {
            cause,
          }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(AiGatewayActivity, make);
