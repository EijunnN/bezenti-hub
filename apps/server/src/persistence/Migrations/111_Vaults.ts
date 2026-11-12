import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Vaults (spec 5 ticket 02): named sets of secrets, each under an environment-variable name. Only
// metadata lives here: a value is a sealed entry of the Hub's secret store (`vault-value-<entry
// id>`, its own purpose), never a column. `space_id` is not a foreign key: an Organization's
// deletion removes its Vaults itself (ticket 07).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE vaults (
      vault_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      space_id TEXT,
      is_main INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT,
      CHECK (is_main = 0 OR space_id IS NULL)
    )
  `;
  // One Main vault per Hub; names are unique, so a Vault is never mistaken for another.
  yield* sql`CREATE UNIQUE INDEX vaults_main_idx ON vaults (is_main) WHERE is_main = 1`;
  yield* sql`CREATE UNIQUE INDEX vaults_name_idx ON vaults (name COLLATE NOCASE)`;
  yield* sql`CREATE INDEX vaults_space_idx ON vaults (space_id)`;

  // A Secret link keeps `linked_entry_id` after its original is deleted: then it is broken.
  yield* sql`
    CREATE TABLE vault_entries (
      entry_id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(vault_id),
      name TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('own', 'copy', 'link')),
      linked_entry_id TEXT,
      unmasked INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      CHECK ((kind = 'link') = (linked_entry_id IS NOT NULL))
    )
  `;
  yield* sql`CREATE UNIQUE INDEX vault_entries_name_idx ON vault_entries (vault_id, name)`;
  yield* sql`CREATE INDEX vault_entries_linked_idx ON vault_entries (linked_entry_id)`;

  yield* sql`
    CREATE TABLE vault_allowances (
      vault_id TEXT NOT NULL REFERENCES vaults(vault_id),
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('space', 'user')),
      subject_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (vault_id, subject_kind, subject_id)
    )
  `;
  yield* sql`
    CREATE TABLE space_default_vaults (
      space_id TEXT NOT NULL,
      vault_id TEXT NOT NULL REFERENCES vaults(vault_id),
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (space_id, vault_id)
    )
  `;
  yield* sql`
    CREATE TABLE project_vault_choices (
      project_id TEXT NOT NULL,
      vault_id TEXT NOT NULL REFERENCES vaults(vault_id),
      choice TEXT NOT NULL CHECK (choice IN ('add', 'remove')),
      PRIMARY KEY (project_id, vault_id)
    )
  `;

  // A known text sealed with the master key: a Hub whose key does not open it does not start
  // (a database restored beside another key's secrets). Re-sealed when the key rotates.
  yield* sql`
    CREATE TABLE vault_key_check (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      key_id TEXT NOT NULL,
      sealed BLOB NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
