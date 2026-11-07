/**
 * A Thread's Active environment as the projection records it (`active_environment_id`, migration
 * 096). A Thread not projected yet runs on the Hub machine, only while it runs agents (otherwise
 * nowhere: work waits for its placement); one whose Environment was removed has none until it moves.
 */
import { EnvironmentId, HUB_MACHINE_ENVIRONMENT_ID, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ActiveEnvironmentResolver, NO_ENVIRONMENT_ID } from "./EnvironmentExecutor.ts";
import * as HubRunsAgents from "./HubRunsAgents.ts";

export const layerActiveEnvironmentResolver = Layer.effect(
  ActiveEnvironmentResolver,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const unprojected = (yield* HubRunsAgents.HubRunsAgents)
      ? HUB_MACHINE_ENVIRONMENT_ID
      : NO_ENVIRONMENT_ID;
    return {
      // Read on every call that needs the machine: a Thread that moves is seen at once.
      // Asked per provider event: too frequent for a span each.
      resolve: Effect.fnUntraced(
        function* (threadId: ThreadId) {
          const rows = yield* sql<{ readonly environmentId: string | null }>`
              SELECT active_environment_id AS "environmentId"
              FROM orchestration_v2_projection_threads
              WHERE thread_id = ${threadId}
            `;
          const row = rows[0];
          if (row === undefined) return unprojected;
          return row.environmentId === null
            ? NO_ENVIRONMENT_ID
            : EnvironmentId.make(row.environmentId);
        },
        // An unreadable row must not send work to another machine: no executor answers it,
        // so the work fails and retries.
        Effect.orElseSucceed(() => NO_ENVIRONMENT_ID),
        Effect.withTracerEnabled(false),
      ),
    };
  }),
);
