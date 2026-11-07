/**
 * Removes secrets a migration retired. A migration only reaches SQL, so it records the names of
 * secrets that no longer belong to anything (migration 102: removed Peer Links' tokens) and this
 * removes them from the server secret store at startup. A failure leaves the name for the next
 * start.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "./ServerSecretStore.ts";

export const removeRetiredSecrets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const retired = yield* sql<{ readonly secret_name: string }>`
    SELECT secret_name FROM retired_server_secrets
  `;
  for (const { secret_name: name } of retired) {
    yield* secrets.remove(name);
    yield* sql`DELETE FROM retired_server_secrets WHERE secret_name = ${name}`;
  }
}).pipe(
  Effect.catchCause((cause) => Effect.logWarning("Could not remove retired secrets", { cause })),
  Effect.withSpan("RetiredSecrets.remove"),
);
