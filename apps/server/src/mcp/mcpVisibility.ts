import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

/** What an MCP caller may see: its User's Spaces, or everything for a caller with no User. */
export const visibilityOf = Effect.fn("mcp.visibilityOf")(function* (
  scope: Pick<McpInvocationScope, "userId">,
) {
  if (scope.userId === undefined) return SpaceVisibility.everything;
  const service = yield* Effect.serviceOption(SpaceVisibility.SpaceVisibility);
  // A User's caller must never read unfiltered because the service is missing.
  if (Option.isNone(service)) return yield* Effect.die("SpaceVisibility is not provided to MCP");
  return yield* service.value.of(scope.userId);
});

/** The shells among `shells` the caller may see. */
export const visibleShells = Effect.fn("mcp.visibleShells")(function* <
  A extends Pick<OrchestrationV2ThreadShell, "id">,
>(scope: Pick<McpInvocationScope, "userId">, shells: ReadonlyArray<A>) {
  const visibility = yield* visibilityOf(scope);
  if (visibility.all) return shells;
  const service = yield* Effect.serviceOption(SpaceVisibility.SpaceVisibility);
  if (Option.isNone(service)) return yield* Effect.die("SpaceVisibility is not provided to MCP");
  const visible = yield* service.value.visibleThreadIds(
    visibility,
    shells.map((shell) => shell.id),
  );
  return shells.filter((shell) => visible.has(shell.id));
});
