import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Only the token's hash is stored; the link is shown once to the person who created it.
  yield* sql`
    CREATE TABLE space_invitations (
      invitation_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(space_id),
      role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL REFERENCES users(user_id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      accepted_by TEXT REFERENCES users(user_id),
      revoked_at TEXT,
      CHECK (accepted_at IS NULL OR revoked_at IS NULL)
    )
  `;
  yield* sql`CREATE INDEX space_invitations_space_idx ON space_invitations(space_id, created_at)`;
});
