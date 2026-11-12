/**
 * The database's key check: a known text sealed with the master key in `vault_key_check`, so a
 * database restored beside another key's secrets stops the Hub instead of losing its Vaults.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as MasterKeyFile from "../auth/MasterKeyFile.ts";
import * as SecretCipher from "../auth/SecretCipher.ts";

const KEY_CHECK_NAME = "vault_key_check";
const KEY_CHECK_TEXT = "t3code vault key check";

const keyCheckFailure = (detail: string) =>
  new MasterKeyFile.MasterKeyError({ reason: "wrong-key", detail });

/**
 * The database's key check: a known text sealed with the master key. Missing, it is written;
 * sealed with the previous key (a rotation), it is sealed again with the current one; not opened
 * by any key the Hub holds, the Hub does not start.
 */
export const checkDatabaseKey = Effect.fn("Vaults.checkDatabaseKey")(function* (
  keyring: MasterKeyFile.Keyring,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = DateTime.formatIso(yield* DateTime.now);
  const rows = yield* sql<{ readonly keyId: string; readonly sealed: Uint8Array }>`
    SELECT key_id AS "keyId", sealed AS "sealed" FROM vault_key_check WHERE id = 1
  `;
  const sealCurrent = () =>
    SecretCipher.seal(
      keyring.current,
      "key-check",
      KEY_CHECK_NAME,
      new TextEncoder().encode(KEY_CHECK_TEXT),
    );
  const stored = rows[0];
  if (stored === undefined) {
    yield* sql`
      INSERT INTO vault_key_check (id, key_id, sealed, updated_at)
      VALUES (1, ${keyring.current.id}, ${sealCurrent()}, ${at})
      ON CONFLICT (id) DO NOTHING
    `;
    return;
  }
  const opened = SecretCipher.open(
    keyring.keys,
    "key-check",
    KEY_CHECK_NAME,
    Uint8Array.from(stored.sealed),
  );
  if (opened._tag !== "opened" || new TextDecoder().decode(opened.plaintext) !== KEY_CHECK_TEXT) {
    return yield* keyCheckFailure(
      `The master key ${keyring.keyFile} (id ${keyring.current.id}) opens the secrets folder but not this database's key check (id ${stored.keyId}): the database and the secrets folder come from different Hubs. The Hub does not start and did not change the database (the secrets folder was already checked, and prepared, with this key). Restore the matching database or master key from your backup (\`t3 secrets key import <file>\`, or T3CODE_MASTER_KEY_FILE).`,
    );
  }
  if (stored.keyId !== keyring.current.id) {
    yield* sql`
      UPDATE vault_key_check SET key_id = ${keyring.current.id}, sealed = ${sealCurrent()}, updated_at = ${at}
      WHERE id = 1
    `;
  }
});
