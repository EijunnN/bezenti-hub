import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-01T00:00:00.000Z";

it.effect("drops the Vault rows a Hub before ticket 07 left naming a reach that is gone", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 114 });
    yield* sql`
      INSERT INTO users (user_id, display_name, is_owner, created_at) VALUES
        ('owner', 'Owner', 1, ${AT}), ('grace', 'grace', 0, ${AT}), ('gone', 'gone', 0, ${AT})
    `;
    yield* sql`UPDATE users SET removed_at = ${AT}, disabled_at = ${AT} WHERE user_id = 'gone'`;
    yield* sql`
      INSERT INTO spaces (space_id, kind, name, created_at) VALUES
        ('org-acme', 'organization', 'Acme', ${AT}), ('org-globex', 'organization', 'Globex', ${AT})
    `;
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, space_id)
      VALUES ('web', 'web', '/w/web', '[]', ${AT}, ${AT}, 'org-globex')
    `;
    const vault = (id: string, spaceId: string | null) => sql`
      INSERT INTO vaults (vault_id, name, space_id, is_main, created_at, updated_at)
      VALUES (${id}, ${id}, ${spaceId}, 0, ${AT}, ${AT})
    `;
    yield* vault("tools", null);
    yield* vault("acme-keys", "org-acme");
    yield* vault("globex-keys", "org-globex");
    yield* vault("initech-keys", "org-initech");
    yield* sql`
      INSERT INTO vault_entries (entry_id, vault_id, name, kind, value_id, created_at, updated_at)
      VALUES ('e1', 'initech-keys', 'INITECH', 'own', 'value-1', ${AT}, ${AT})
    `;
    const allow = (kind: string, subject: string) => sql`
      INSERT INTO vault_allowances (vault_id, subject_kind, subject_id, created_at)
      VALUES ('tools', ${kind}, ${subject}, ${AT})
    `;
    yield* allow("space", "org-acme");
    yield* allow("space", "org-initech");
    yield* allow("user", "grace");
    yield* allow("user", "gone");
    // The Project moved from Acme to Globex: its choices of Acme's and Tools (Acme only) stayed.
    for (const vaultId of ["acme-keys", "tools", "globex-keys"]) {
      yield* sql`
        INSERT INTO project_vault_choices (project_id, vault_id, choice) VALUES ('web', ${vaultId}, 'add')
      `;
    }
    yield* sql`
      INSERT INTO space_default_vaults (space_id, vault_id, position) VALUES
        ('org-globex', 'acme-keys', 0), ('org-globex', 'globex-keys', 1), ('org-acme', 'tools', 0)
    `;

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 115 }), [
      [115, "VaultUnreachableRows"],
    ]);
    const ids = (rows: ReadonlyArray<Record<string, unknown>>) =>
      rows.map((row) => Object.values(row).join(":"));
    assert.deepEqual(
      ids(yield* sql`SELECT vault_id FROM vaults ORDER BY vault_id`),
      ["acme-keys", "globex-keys", "tools"],
      "Initech is gone: its Vault goes",
    );
    assert.deepEqual(ids(yield* sql`SELECT entry_id FROM vault_entries`), []);
    assert.deepEqual(
      ids(yield* sql`SELECT subject_kind, subject_id FROM vault_allowances ORDER BY subject_id`),
      ["user:grace", "space:org-acme"],
    );
    assert.deepEqual(
      ids(yield* sql`SELECT vault_id FROM project_vault_choices ORDER BY vault_id`),
      ["globex-keys"],
    );
    assert.deepEqual(
      ids(
        yield* sql`SELECT space_id, vault_id FROM space_default_vaults ORDER BY space_id, vault_id`,
      ),
      ["org-acme:tools", "org-globex:globex-keys"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
