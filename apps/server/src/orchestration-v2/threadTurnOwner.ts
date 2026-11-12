/**
 * Whose a Thread's turns are: its owner, or its root Thread's owner (a child Thread). The one rule
 * for who a turn runs as: the secrets it receives (SecretDelivery) and the User a Thread's gateway
 * key acts for (AiGatewayKeys).
 */
import { UserId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";

export const threadTurnOwner = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ readonly ownerUserId: string | null }>`
    SELECT COALESCE(t.owner_user_id, root.owner_user_id) AS "ownerUserId"
    FROM orchestration_v2_projection_threads t
    LEFT JOIN orchestration_v2_projection_threads root
      ON root.thread_id = json_extract(t.payload_json, '$.lineage.rootThreadId')
    WHERE t.thread_id = ${threadId}
  `.pipe(
    Effect.map((rows) => {
      const owner = rows[0]?.ownerUserId ?? null;
      return owner === null ? Option.none<UserId>() : Option.some(UserId.make(owner));
    }),
  );
