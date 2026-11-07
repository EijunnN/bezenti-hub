import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const at = "2026-10-01T00:00:00.000Z";

it.effect("revokes Peer Link credentials, then drops their rows and cards", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 99 });

    // This server linked to another: the token is in the secret store under `secret_name`.
    yield* sql`
      INSERT INTO peer_environment_links (
        environment_id, secret_name, label, urls_json, access, linked_at, expires_at, fenced
      ) VALUES (
        'environment-box', 'peer-link-0123', 'Box', '["https://box.example"]', 'auto',
        ${at}, '2027-10-01T00:00:00.000Z', 1
      )
    `;
    // Another server linked to this one, and its agent started a Thread here.
    for (const sessionId of ["session-link", "session-outside-agent"]) {
      yield* sql`
        INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES (${sessionId}, 'mcp-client', '[]', 'bearer-access-token', ${at}, '2027-10-01')
      `;
    }
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project-web', 'web', '/srv/web', '[]', ${at}, ${at})
    `;
    const linkedPayload = JSON.stringify({
      title: "Linked work",
      linkOrigin: { sessionId: "session-link", label: "T3 Code · laptop", access: "auto" },
      delegatedFrom: { environmentId: "environment-laptop", threadId: "thread-there", title: "P" },
    });
    for (const [threadId, payload] of [
      ["thread-linked", linkedPayload],
      ["thread-own", JSON.stringify({ title: "Own work" })],
    ] as const) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        ) VALUES (${threadId}, 'project-web', 'T', 'codex', 'full-access', 'default', ${at}, ${at}, ${payload})
      `;
    }
    for (const [itemId, type] of [
      ["item-link", "link_request"],
      ["item-secret", "secret_request"],
    ] as const) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (${itemId}, 'thread-own', 1, ${type}, 'waiting', ${at}, '{}')
      `;
    }

    assert.deepEqual(yield* runMigrations(), [[102, "RemovePeerLinks"]]);

    const sessions = yield* sql<{ readonly id: string; readonly revoked: number }>`
      SELECT session_id AS id, revoked_at IS NOT NULL AS revoked FROM auth_sessions ORDER BY session_id
    `;
    assert.deepEqual(sessions, [
      { id: "session-link", revoked: 1 },
      { id: "session-outside-agent", revoked: 0 },
    ]);
    const retired = yield* sql<{ readonly name: string }>`
      SELECT secret_name AS name FROM retired_server_secrets
    `;
    assert.deepEqual(retired, [{ name: "peer-link-0123" }]);
    const linkTables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE name IN ('peer_environment_links', 'orchestration_v2_projection_turn_items_waiting_link_idx')
    `;
    assert.deepEqual(linkTables, []);
    const items = yield* sql<{ readonly id: string }>`
      SELECT turn_item_id AS id FROM orchestration_v2_projection_turn_items
    `;
    assert.deepEqual(items, [{ id: "item-secret" }]);
    const threads = yield* sql<{ readonly id: string; readonly payload: string }>`
      SELECT thread_id AS id, payload_json AS payload FROM orchestration_v2_projection_threads
      ORDER BY thread_id
    `;
    assert.deepEqual(
      threads.map((thread) => [thread.id, JSON.parse(thread.payload)]),
      [
        ["thread-linked", { title: "Linked work" }],
        ["thread-own", { title: "Own work" }],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
