import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { authorizeRpcCall, scopesOfUser } from "../auth/RpcAuthorization.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { requireCloneDestination } from "../project/cloneDestination.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { spaceVisibilityService, visibilityOf } from "./mcpVisibility.ts";

/**
 * An MCP tool that does what a WS RPC does is authorized by that RPC's own check
 * (`authorizeRpcCall`), as its caller's User: no tool keeps a parallel rule of its own.
 */
export const authorizeAsRpc = Effect.fn("mcp.authorizeAsRpc")(function* (
  method: string,
  payload: unknown,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const visibility = yield* visibilityOf(scope);
  // Only a User who does not see everything is ever asked about Spaces.
  const spaceVisibility = visibility.all
    ? ({} as Effect.Success<typeof spaceVisibilityService>)
    : yield* spaceVisibilityService;
  yield* authorizeRpcCall(
    method,
    payload,
    { scopes: scopesOfUser(visibility), visibility, userId: scope.userId },
    spaceVisibility,
  ).pipe(
    Effect.mapError(
      (refusal) =>
        new OrchestratorMcpFailure({ code: "capability_denied", message: refusal.message }),
    ),
  );
});

/** Where the caller may clone: the same check as cloning from the app. */
export const requireMcpCloneDestination = Effect.fn("mcp.requireCloneDestination")(function* (
  destinationPath: string,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const visibility = yield* visibilityOf(scope);
  yield* requireCloneDestination({ visibility, userId: scope.userId }, destinationPath, {
    spaceVisibility: spaceVisibilityService,
    projectsRoot: Effect.serviceOption(ManagedProjectFolders.ManagedProjectFolders).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die("ManagedProjectFolders is not provided to MCP"),
          onSome: (folders) => Effect.succeed(folders.namedProjectsRoot),
        }),
      ),
    ),
  }).pipe(
    Effect.mapError(
      (refusal) => new OrchestratorMcpFailure({ code: "invalid_request", message: refusal.detail }),
    ),
  );
});
