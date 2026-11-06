import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Append-only and kept forever: nothing updates or deletes a row, and no foreign key ties it to
// the Users, Spaces or items it names, so an entry outlives what it is about.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE audit_log (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor_source TEXT NOT NULL CHECK (actor_source IN ('user', 'agent', 'cli', 'system')),
      actor_user_id TEXT,
      space_id TEXT,
      space_name TEXT,
      action TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}',
      CHECK (actor_source <> 'user' OR actor_user_id IS NOT NULL),
      CHECK (actor_source <> 'system' OR actor_user_id IS NULL)
    )
  `;
  yield* sql`CREATE INDEX audit_log_action_idx ON audit_log(action, audit_id)`;
  yield* sql`CREATE INDEX audit_log_actor_idx ON audit_log(actor_user_id, audit_id)`;
  yield* sql`CREATE INDEX audit_log_space_idx ON audit_log(space_id, audit_id)`;
  yield* sql`
    CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END
  `;
  yield* sql`
    CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END
  `;
});
