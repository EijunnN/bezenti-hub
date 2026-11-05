import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE spaces (
      space_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('organization', 'personal')),
      name TEXT NOT NULL,
      personal_owner_user_id TEXT REFERENCES users(user_id),
      created_at TEXT NOT NULL,
      archived_at TEXT,
      frozen_at TEXT,
      CHECK ((kind = 'personal') = (personal_owner_user_id IS NOT NULL))
    )
  `;
  // Each User has exactly one Personal space.
  yield* sql`
    CREATE UNIQUE INDEX spaces_personal_owner_idx ON spaces(personal_owner_user_id)
    WHERE personal_owner_user_id IS NOT NULL
  `;

  // A Personal space has no rows here: its User and the Owner are implicit.
  yield* sql`
    CREATE TABLE space_memberships (
      space_id TEXT NOT NULL REFERENCES spaces(space_id),
      user_id TEXT NOT NULL REFERENCES users(user_id),
      role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (space_id, user_id)
    )
  `;
  yield* sql`CREATE INDEX space_memberships_user_idx ON space_memberships(user_id)`;

  // Rows created before Spaces keep NULL in both columns and belong to the Owner's Personal space.
  yield* sql`ALTER TABLE projection_projects ADD COLUMN space_id TEXT`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN owner_user_id TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN space_id TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN owner_user_id TEXT`;
});
