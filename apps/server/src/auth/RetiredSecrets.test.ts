import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
  it.effect("removes each retired secret on its own, and drops the record once empty", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const bytes = new TextEncoder().encode("token");
      yield* secrets.set("peer-link-0123", bytes);
      yield* secrets.set("server-signing-key", bytes);
      // One that cannot be removed: a directory with something in it stands where it would be.
      const stuck = `${secrets.directory}/peer-link-0-stuck.bin`;
      yield* fs.makeDirectory(`${stuck}/inside`, { recursive: true });
      yield* sql`
        INSERT INTO retired_server_secrets (secret_name)
        VALUES ('peer-link-0-stuck'), ('peer-link-0123'), ('peer-link-gone')
      `;

      yield* removeRetiredSecrets;

      // The failure stopped nothing else, and is kept for the next start.
      assert.isTrue(Option.isNone(yield* secrets.get("peer-link-0123")));
      assert.isTrue(Option.isSome(yield* secrets.get("server-signing-key")));
      assert.deepEqual(yield* sql`SELECT secret_name FROM retired_server_secrets`, [
        { secret_name: "peer-link-0-stuck" },
      ]);

      yield* fs.remove(stuck, { recursive: true });
      yield* removeRetiredSecrets;
      const table = yield* sql`
        SELECT name FROM sqlite_master WHERE name = 'retired_server_secrets'
      `;
      assert.deepEqual(table, []);
      // Later starts find nothing to do.
      yield* removeRetiredSecrets;
    }),
  );
});
