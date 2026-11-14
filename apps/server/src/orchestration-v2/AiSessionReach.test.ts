import { assert, it } from "@effect/vitest";
import {
  type AiAccountId,
  ProviderSessionId,
  type SpaceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as AllowedAiAccounts from "../ai/AllowedAiAccounts.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as AiSessionReach from "./AiSessionReach.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const AT = "2026-11-01T00:00:00.000Z";
const ACME = "org-acme" as SpaceId;
const GLOBEX = "org-globex" as SpaceId;
const KEPT = "kept" as AiAccountId;
const LOST = "lost" as AiAccountId;

const session = (
  id: string,
  thread: string,
  owner: string,
  accountId: AiAccountId,
  direct: boolean,
): ProviderSessionManager.LiveAiSession => ({
  providerSessionId: ProviderSessionId.make(id),
  threadIds: [ThreadId.make(thread)],
  facts: { ownerUserId: UserId.make(owner), spaceId: ACME, accountId, direct },
});

it.effect(
  "closes what merely lost access only when it holds a direct credential, everything moved or of a removed User, and each owner on their own",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO users (user_id, display_name, is_owner, created_at) VALUES
          ('owner', 'Owner', 1, ${AT}), ('ada', 'ada', 0, ${AT}), ('gone', 'gone', 0, ${AT}),
          ('flaky', 'flaky', 0, ${AT}), ('slow', 'slow', 0, ${AT})
      `;
      yield* sql`UPDATE users SET removed_at = ${AT} WHERE user_id = 'gone'`;
      const thread = (id: string, owner: string, spaceId: SpaceId) => sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json, space_id, owner_user_id
        ) VALUES (${id}, 'p', ${id}, 'claudeAgent', 'full-access', 'default', ${AT}, ${AT}, '{}',
          ${spaceId}, ${owner})
      `;
      yield* thread("t-direct-lost", "owner", ACME);
      yield* thread("t-gateway-lost", "owner", ACME);
      yield* thread("t-kept", "owner", ACME);
      yield* thread("t-moved", "ada", GLOBEX);
      yield* thread("t-removed", "gone", ACME);
      yield* thread("t-flaky-direct", "flaky", ACME);
      yield* thread("t-flaky-gateway", "flaky", ACME);
      yield* thread("t-slow", "slow", ACME);

      const live = [
        session("direct-lost", "t-direct-lost", "owner", LOST, true),
        session("gateway-lost", "t-gateway-lost", "owner", LOST, false),
        session("kept", "t-kept", "owner", KEPT, true),
        session("moved", "t-moved", "ada", KEPT, false),
        session("removed", "t-removed", "gone", KEPT, false),
        session("flaky-direct", "t-flaky-direct", "flaky", KEPT, true),
        session("flaky-gateway", "t-flaky-gateway", "flaky", KEPT, false),
        session("slow", "t-slow", "slow", KEPT, true),
      ];
      const released: Array<string> = [];
      let slowCalls = 0;
      const allowed = (accounts: ReadonlyArray<AiAccountId>) =>
        new Map([
          [
            ACME,
            accounts.map((id) => ({
              id,
              name: id,
              type: "api-key" as const,
              provider: "claude" as const,
              priority: 1,
            })),
          ],
        ]);
      const layer = AiSessionReach.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              ProviderSessionManager.ProviderSessionManagerV2,
              ProviderSessionManager.ProviderSessionManagerV2.of({
                liveAiSessions: Effect.succeed(live),
                subscribeAiSessionOpens: Effect.succeed(Stream.never),
                release: ({ providerSessionId }: { readonly providerSessionId: string }) =>
                  Effect.sync(() => void released.push(providerSessionId)),
              } as never),
            ),
            Layer.succeed(
              AllowedAiAccounts.AllowedAiAccounts,
              AllowedAiAccounts.AllowedAiAccounts.of({
                forSpaces: (userId: UserId) =>
                  Effect.suspend(() => {
                    if (userId === "flaky") {
                      return Effect.fail(
                        new AllowedAiAccounts.AllowedAiAccountsError({ message: "down" }),
                      );
                    }
                    // Fails once, then answers: read again, never failed closed.
                    if (userId === "slow" && (slowCalls += 1) === 1) {
                      return Effect.fail(
                        new AllowedAiAccounts.AllowedAiAccountsError({ message: "busy" }),
                      );
                    }
                    return Effect.succeed(allowed([KEPT]));
                  }),
              } as never),
            ),
            Layer.succeed(
              SpaceDirectory.SpaceDirectory,
              SpaceDirectory.SpaceDirectory.of({
                subscribeMembershipChanges: Effect.succeed(Stream.never),
                subscribeUserStatusChanges: Effect.succeed(Stream.never),
              } as never),
            ),
          ),
        ),
      );
      const closed = yield* Effect.service(AiSessionReach.AiSessionReach).pipe(
        Effect.flatMap((reach) => reach.reconcile),
        Effect.provide(layer),
      );
      assert.deepEqual(
        [...closed].toSorted(),
        ["direct-lost", "flaky-direct", "moved", "removed"],
        "a gateway session whose owner merely lost the account keeps its process",
      );
      assert.deepEqual(released.toSorted(), [...closed].toSorted());
      assert.equal(slowCalls, 2, "a failed read is tried once more");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
