import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";

import { boundSpaceOf } from "./sandboxSpace.ts";

it.effect("a Space check that cannot read the Hub's Environments fails, closed", () =>
  Effect.gen(function* () {
    // No `environments` table: the read fails, as a locked or broken database would.
    const checked = yield* boundSpaceOf(EnvironmentId.make("env-vps")).pipe(Effect.flip);
    assert.equal(checked._tag, "SpaceCheckUnavailableError");
    assert.isTrue(checked.retryable);
    assert.equal(yield* boundSpaceOf(EnvironmentId.make("sandbox:org-acme")), "org-acme");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
