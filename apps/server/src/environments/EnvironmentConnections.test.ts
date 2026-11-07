import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as EnvironmentConnections from "./EnvironmentConnections.ts";

it.effect("a replaced socket's late welcome does not make the new one ready", () =>
  Effect.gen(function* () {
    const connections = yield* EnvironmentConnections.EnvironmentConnections;
    const environmentId = EnvironmentId.make("sandbox:acme");
    const first = yield* connections.attach(environmentId, () => Effect.void);
    const second = yield* connections.attach(environmentId, () => Effect.void);
    yield* first.markReady;
    assert.isFalse(yield* connections.isReady(environmentId));
    yield* second.markReady;
    assert.isTrue(yield* connections.isReady(environmentId));
    yield* connections.awaitReady(environmentId);
  }).pipe(Effect.scoped, Effect.provide(EnvironmentConnections.layer)),
);
