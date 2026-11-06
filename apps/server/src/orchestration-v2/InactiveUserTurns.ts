/**
 * Once the Owner disables or removes a User, their running turns stop: an agent speaking as them
 * must not keep working after their sessions ended.
 */
import { CommandId, ProjectId, ThreadId, type UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Stream from "effect/Stream";

import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const stopTurnsOf = Effect.fn("InactiveUserTurns.stopTurnsOf")(function* (userId: UserId) {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // A child Thread the server made speaks for its root's owner.
  const running = yield* SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ threadId: ThreadId, projectId: ProjectId }),
    execute: (owner) => sql`
      SELECT DISTINCT t.thread_id AS "threadId", t.project_id AS "projectId"
      FROM orchestration_v2_projection_threads t
      LEFT JOIN orchestration_v2_projection_threads root
        ON root.thread_id = json_extract(t.payload_json, '$.lineage.rootThreadId')
      JOIN orchestration_v2_projection_runs r ON r.thread_id = t.thread_id
      WHERE COALESCE(t.owner_user_id, root.owner_user_id) = ${owner}
        AND r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
    `,
  })(userId);
  yield* Effect.forEach(
    running,
    (thread) =>
      threads
        .interruptThread({
          projectId: thread.projectId,
          threadId: thread.threadId,
          commandId: CommandId.make(`inactive-user:${userId}:${thread.threadId}`),
          reason: "The Owner disabled or removed the person who started this turn.",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not stop a disabled User's turn.", {
              threadId: thread.threadId,
              cause,
            }),
          ),
        ),
    { discard: true },
  );
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    const changes = yield* spaces.subscribeUserStatusChanges;
    const context = yield* Effect.context<
      SqlClient.SqlClient | ThreadManagementService.ThreadManagementService
    >();
    yield* changes.pipe(
      Stream.filter((change) => !change.active),
      Stream.runForEach((change) =>
        stopTurnsOf(change.userId).pipe(
          Effect.provide(context),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not stop a disabled User's turns.", { cause }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
