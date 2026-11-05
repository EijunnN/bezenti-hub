import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

// The server provides SpaceVisibility to every MCP request. A caller acting as a User without
// it fails rather than reading unfiltered.
const service = Effect.serviceOption(SpaceVisibility.SpaceVisibility).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.die("SpaceVisibility is not provided to MCP"),
      onSome: Effect.succeed,
    }),
  ),
);

/** What an MCP caller may see: its User's Spaces, or everything for a caller with no User. */
export const visibilityOf = Effect.fn("mcp.visibilityOf")(function* (
  scope: Pick<McpInvocationScope, "userId">,
) {
  if (scope.userId === undefined) return SpaceVisibility.everything;
  return yield* (yield* service).of(scope.userId);
});

/** The shells among `shells` the caller may see. */
export const visibleShells = Effect.fn("mcp.visibleShells")(function* <
  A extends Pick<OrchestrationV2ThreadShell, "id">,
>(scope: Pick<McpInvocationScope, "userId">, shells: ReadonlyArray<A>) {
  const visibility = yield* visibilityOf(scope);
  if (visibility.all) return shells;
  const visible = yield* (yield* service).visibleThreadIds(
    visibility,
    shells.map((shell) => shell.id),
  );
  return shells.filter((shell) => visible.has(shell.id));
});

/**
 * The caller's principal, the same one WS and HTTP callers are authorized by: their User, whether
 * they are the Owner, their Roles and Installation permissions. An agent in a Thread reads as the
 * Thread's owner and an outside client as the User who approved it. Undefined only for a caller
 * with no User, which happens before an Owner exists; such a caller reads as everything.
 */
export const mcpPrincipal = Effect.fn("mcp.principal")(function* (
  scope: Pick<McpInvocationScope, "userId">,
) {
  if (scope.userId === undefined) return undefined;
  return yield* (yield* SpaceDirectory.SpaceDirectory).principalOf(scope.userId);
});
