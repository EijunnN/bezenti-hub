/** A machine's name, for the «<machine> needs an update…» refusals; none when it cannot be read. */
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const machineNameOf = (sql: SqlClient.SqlClient, environmentId: EnvironmentId) =>
  sql<{ readonly name: string }>`
    SELECT name FROM environments WHERE environment_id = ${environmentId}
  `.pipe(
    Effect.map((rows): string | undefined => rows[0]?.name),
    Effect.orElseSucceed((): string | undefined => undefined),
  );
