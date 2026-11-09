import type { OrchestrationV2ThreadShell, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

// The server provides SpaceVisibility to every MCP request. A caller acting as a User without
// it fails rather than reading unfiltered.
export const spaceVisibilityService = Effect.serviceOption(SpaceVisibility.SpaceVisibility).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.die("SpaceVisibility is not provided to MCP"),
      onSome: Effect.succeed,
    }),
  ),
);

/** The current tool call's caller visibility, read once per call by `McpToolAccess`. */
export const CallerVisibility = Context.Reference<Option.Option<SpaceVisibility.Visibility>>(
  "t3/mcp/mcpVisibility/CallerVisibility",
  { defaultValue: () => Option.none() },
);

/** What an MCP caller may see: its User's Spaces, or everything for a caller with no User. */
export const visibilityOf = Effect.fn("mcp.visibilityOf")(function* (
  scope: Pick<McpInvocationScope, "userId" | "spaceLimit">,
) {
  const cached = yield* CallerVisibility;
  if (Option.isSome(cached)) return cached.value;
  const visibility =
    scope.userId === undefined
      ? SpaceVisibility.everything
      : yield* (yield* spaceVisibilityService).of(scope.userId);
  const limit = scope.spaceLimit;
  if (limit === undefined) return visibility;
  // An agent on a machine bound to one Space reads only that Space, whatever its User sees.
  return {
    all: false,
    spaceIds: visibility.all || visibility.spaceIds.includes(limit) ? [limit] : [],
  } satisfies SpaceVisibility.Visibility;
});

/** The shells among `shells` the caller may see. */
export const visibleShells = Effect.fn("mcp.visibleShells")(function* <
  A extends Pick<OrchestrationV2ThreadShell, "id">,
>(scope: Pick<McpInvocationScope, "userId" | "spaceLimit">, shells: ReadonlyArray<A>) {
  const visibility = yield* visibilityOf(scope);
  if (visibility.all) return shells;
  const visible = yield* (yield* spaceVisibilityService).visibleThreadIds(
    visibility,
    shells.map((shell) => shell.id),
  );
  return shells.filter((shell) => visible.has(shell.id));
});

/** Whether the caller may see the Project; a hidden one is answered like a missing one. */
export const seesProjectId = Effect.fn("mcp.seesProjectId")(function* (
  scope: Pick<McpInvocationScope, "userId" | "spaceLimit">,
  projectId: ProjectId,
) {
  const visibility = yield* visibilityOf(scope);
  if (visibility.all) return true;
  return (yield* (yield* spaceVisibilityService).visibleProjectIds(visibility, [projectId])).has(
    projectId,
  );
});
