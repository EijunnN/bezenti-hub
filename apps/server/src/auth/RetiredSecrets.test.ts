import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { removeRetiredSecrets } from "./RetiredSecrets.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layer = Layer.mergeAll(ServerSecretStore.layer, SqlitePersistence.layerMemory).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-retired-secrets-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(layer)("RetiredSecrets", (it) => {
  it.effect("removes the secrets a migration retired, and only those", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const bytes = new TextEncoder().encode("token");
      yield* secrets.set("peer-link-0123", bytes);
      yield* secrets.set("server-signing-key", bytes);
      yield* sql`INSERT INTO retired_server_secrets (secret_name) VALUES ('peer-link-0123')`;
      // Already gone from the store: still forgotten.
      yield* sql`INSERT INTO retired_server_secrets (secret_name) VALUES ('peer-link-gone')`;

      yield* removeRetiredSecrets;

      assert.isTrue(Option.isNone(yield* secrets.get("peer-link-0123")));
      assert.isTrue(Option.isSome(yield* secrets.get("server-signing-key")));
      assert.deepEqual(yield* sql`SELECT secret_name FROM retired_server_secrets`, []);
    }),
  );
});
