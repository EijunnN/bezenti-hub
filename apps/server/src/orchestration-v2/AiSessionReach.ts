/**
 * Spec 4 ticket 11: a provider process on a Hub AI account lives only while its Thread's Space,
 * turn owner and account (AllowedAiAccounts) still hold; else it is closed, not restarted (the
 * next turn opens a new one). docs/internals/ai-gateway.md, «Moving a Project and removals».
 */
import { type AiAccountId, type SpaceId, type ThreadId, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AiAccountChanges from "../ai/AiAccountChanges.ts";
import * as AllowedAiAccounts from "../ai/AllowedAiAccounts.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const OWNER_ID = "(SELECT user_id FROM users WHERE is_owner = 1)";

export class AiSessionReach extends Context.Service<
  AiSessionReach,
  {
    /** Asks for a check of every live AI session; bursts coalesce into one, run in the background. */
    readonly request: Effect.Effect<void>;
    /** One check now: the sessions it closed. For tests and the background worker. */
    readonly reconcile: Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/orchestration-v2/AiSessionReach") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const allowedAccounts = yield* AllowedAiAccounts.AllowedAiAccounts;

  /** Each Thread's Space and turn owner now (SpaceDirectory's and threadTurnOwner's rules). */
  const threadFacts = (threadIds: ReadonlyArray<ThreadId>) =>
    sql<{
      readonly threadId: string;
      readonly spaceId: string | null;
      readonly ownerUserId: string | null;
      readonly gone: number;
    }>`
      SELECT t.thread_id AS "threadId",
        COALESCE(t.space_id, p.space_id, 'personal:' || ${sql.literal(OWNER_ID)}) AS "spaceId",
        COALESCE(t.owner_user_id, root.owner_user_id) AS "ownerUserId",
        (t.deleted_at IS NOT NULL OR t.archived_at IS NOT NULL) AS "gone"
      FROM orchestration_v2_projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      LEFT JOIN orchestration_v2_projection_threads root
        ON root.thread_id = json_extract(t.payload_json, '$.lineage.rootThreadId')
      WHERE ${sql.in("t.thread_id", threadIds)}
    `;

  const reconcile = Effect.gen(function* () {
    // One read of the live sessions, from memory; then one of their Threads, one per owner.
    const live = yield* sessions.liveAiSessions;
    if (live.length === 0) return [] as ReadonlyArray<string>;
    const threadIds = [...new Set(live.flatMap((session) => session.threadIds))];
    const facts = new Map(
      (threadIds.length === 0 ? [] : yield* threadFacts(threadIds)).map((row) => [
        row.threadId,
        row,
      ]),
    );
    // Only for sessions whose Thread still matches: a Space each (owner) was started for.
    const asked = new Map<UserId, Set<SpaceId>>();
    for (const session of live) {
      const spaces = asked.get(session.facts.ownerUserId) ?? new Set<SpaceId>();
      spaces.add(session.facts.spaceId);
      asked.set(session.facts.ownerUserId, spaces);
    }
    const allowed = new Map<string, ReadonlySet<AiAccountId>>();
    for (const [ownerUserId, spaceIds] of asked) {
      const answer = yield* allowedAccounts.forSpaces(ownerUserId, [...spaceIds]);
      for (const [spaceId, accounts] of answer) {
        allowed.set(`${ownerUserId} ${spaceId}`, new Set(accounts.map((account) => account.id)));
      }
    }
    const stale = live.filter((session) => {
      const { ownerUserId, spaceId, accountId } = session.facts;
      const reaches = allowed.get(`${ownerUserId} ${spaceId}`)?.has(accountId) === true;
      if (!reaches) return true;
      // Every Thread on it must still be in that Space, run by that owner.
      return session.threadIds.some((threadId) => {
        const thread = facts.get(threadId);
        return (
          thread === undefined ||
          thread.gone === 1 ||
          thread.spaceId !== spaceId ||
          thread.ownerUserId === null ||
          UserId.make(thread.ownerUserId) !== ownerUserId
        );
      });
    });
    yield* Effect.forEach(
      stale,
      (session) =>
        sessions
          .release({
            providerSessionId: session.providerSessionId,
            reason: "manual_shutdown",
            detail: "Its AI account is no longer within reach of this Thread.",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("AiSessionReach: could not close a session out of reach", {
                providerSessionId: session.providerSessionId,
                cause,
              }),
            ),
          ),
      { concurrency: "unbounded", discard: true },
    );
    return stale.map((session) => session.providerSessionId as string);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("AiSessionReach: could not check the live AI sessions", { cause }).pipe(
        Effect.as([] as ReadonlyArray<string>),
      ),
    ),
  );

  // One pending check at most: requests made while one runs are answered by the next.
  const pending = yield* Queue.sliding<void>(1);
  yield* Queue.take(pending).pipe(Effect.andThen(reconcile), Effect.forever, Effect.forkScoped);
  const request = Queue.offer(pending, undefined).pipe(Effect.asVoid);

  // What can end a reach elsewhere: a Membership, a User's status, an account or its allowances.
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const forEachChange = <A>(changes: Stream.Stream<A>) =>
    changes.pipe(
      Stream.runForEach(() => request),
      Effect.forkScoped,
    );
  yield* forEachChange(yield* spaces.subscribeMembershipChanges);
  yield* forEachChange(yield* spaces.subscribeUserStatusChanges);
  const accountChanges = yield* Effect.serviceOption(AiAccountChanges.AiAccountChanges);
  if (Option.isSome(accountChanges)) {
    yield* forEachChange(yield* accountChanges.value.subscribe);
  }

  return AiSessionReach.of({ request, reconcile });
});

export const layer = Layer.effect(AiSessionReach, make);
