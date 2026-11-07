/**
 * Removes secrets a migration retired. A migration only reaches SQL, so it records the names of
 * secrets that no longer belong to anything (migration 102: removed Peer Links' tokens) and this
 * removes them from the server secret store at startup. Each name is removed on its own: one that
 * fails is logged and kept for the next start. The table goes once it is empty.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "./ServerSecretStore.ts";

export const removeRetiredSecrets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const table = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'retired_server_secrets'
  `;
  if (table.length === 0) return;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const retired = yield* sql<{ readonly secret_name: string }>`
    SELECT secret_name FROM retired_server_secrets
  `;
  for (const { secret_name: name } of retired) {
    yield* secrets.remove(name).pipe(
      Effect.andThen(sql`DELETE FROM retired_server_secrets WHERE secret_name = ${name}`),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not remove a retired secret", { name, cause }),
      ),
    );
  }
  const [left] = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM retired_server_secrets
  `;
  if (left?.count === 0) yield* sql`DROP TABLE retired_server_secrets`;
}).pipe(
  Effect.catchCause((cause) => Effect.logWarning("Could not remove retired secrets", { cause })),
  Effect.withSpan("RetiredSecrets.remove"),
);
