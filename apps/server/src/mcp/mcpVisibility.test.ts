import { assert, it } from "@effect/vitest";
import { EnvironmentId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { CallerVisibility, visibilityOf } from "./mcpVisibility.ts";

const scopeOf = (userId: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: userId,
  thread: undefined,
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
  userId: UserId.make(userId),
});

it.effect("reuses a tool call's visibility only for that call's own scope", () =>
  Effect.gen(function* () {
    const caller = scopeOf("owner");
    const other = scopeOf("grace");
    const read = (scope: McpInvocationScope) =>
      visibilityOf(scope).pipe(
        Effect.provideService(
          CallerVisibility,
          Option.some({ scope: caller, visibility: SpaceVisibility.everything }),
        ),
        Effect.provideService(
          SpaceVisibility.SpaceVisibility,
          SpaceVisibility.SpaceVisibility.of({
            of: () => Effect.succeed(SpaceVisibility.nothing),
          } as never),
        ),
      );
    assert.deepEqual(yield* read(caller), SpaceVisibility.everything);
    assert.deepEqual(yield* read(other), SpaceVisibility.nothing);
  }),
);
