import {
  AuthOrchestrationReadScope,
  CommandId,
  type ProjectId,
  type ProjectMutation,
  type SpaceId,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  requiredScopesForProjectMutation,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import * as CommandActor from "../auth/CommandActor.ts";
import { authorizeSessionAsRpc } from "../auth/RpcAuthorization.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectService from "./ProjectService.ts";
import { mutateProjectWithClone } from "./ProjectMutation.ts";

const failProjectMutation = Effect.fn("environment.projects.failMutation")(function* (
  cause: ProjectService.ProjectServiceError | ServerRuntimeStartup.ServerRuntimeStartupError,
) {
  // Stop its running Threads, then try again.
  if (cause._tag === "ProjectMoveBlockedError") {
    return yield* new EnvironmentHttpConflictError({ message: cause.message });
  }
  if (cause._tag === "SpaceAccessDeniedError") {
    return yield* new EnvironmentHttpForbiddenError({ message: cause.message });
  }
  if (
    cause._tag === "ProjectNotFoundError" ||
    cause._tag === "ProjectConflictError" ||
    cause._tag === "ProjectNotEmptyError" ||
    cause._tag === "SpaceNotFoundError" ||
    // A hidden Project answers like a missing one.
    cause._tag === "SpaceResourceNotFoundError"
  ) {
    return yield* failEnvironmentInvalidRequest("invalid_command");
  }
  return yield* failEnvironmentInternal("project_mutation_failed", cause);
});

/** A move, or its plan, is asked exactly as `projects.mutate`'s `project.move`: its scopes, its rule. */
const authorizeAsMove = Effect.fn("environment.projects.authorizeAsMove")(function* (input: {
  readonly projectId: ProjectId;
  readonly spaceId: SpaceId;
  readonly commandId?: CommandId | undefined;
  readonly stopThreads?: boolean | undefined;
}) {
  const asMove: ProjectMutation = {
    type: "project.move",
    commandId: input.commandId ?? CommandId.make("project-move-plan"),
    projectId: input.projectId,
    spaceId: input.spaceId,
  };
  for (const scope of requiredScopesForProjectMutation(asMove)) {
    yield* requireEnvironmentScope(scope);
  }
  const principal = yield* EnvironmentAuthenticatedPrincipal;
  yield* authorizeSessionAsRpc(WS_METHODS.projectsMutate, asMove, principal).pipe(
    Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
  );
  return principal;
});

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "projects",
  Effect.fnUntraced(function* (handlers) {
    const projects = yield* ProjectService.ProjectService;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const projectClones = yield* ProjectCloneTracker.ProjectCloneTracker;
    const spaceVisibility = yield* SpaceVisibility.SpaceVisibility;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.projects.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          const visibility = yield* spaceVisibility.ofSession(principal);
          return yield* projects
            .snapshotFor(visibility)
            .pipe(
              Effect.catch((cause) => failEnvironmentInternal("project_snapshot_failed", cause)),
            );
        }),
      )
      .handle(
        "mutate",
        Effect.fn("environment.projects.mutate")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          for (const scope of requiredScopesForProjectMutation(args.payload)) {
            yield* requireEnvironmentScope(scope);
          }
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          // The socket's own rule for `projects.mutate`: changing a Project the User cannot see
          // answers like changing a missing one.
          yield* authorizeSessionAsRpc(WS_METHODS.projectsMutate, args.payload, principal).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          const operation = mutateProjectWithClone(
            projects,
            projectClones,
            args.payload,
            principal.userId,
          ).pipe(CommandActor.actAsSession(principal));
          return yield* startup.enqueueCommand(operation).pipe(Effect.catch(failProjectMutation));
        }),
      )
      .handle(
        "move",
        Effect.fn("environment.projects.move")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* authorizeAsMove(args.payload);
          const operation = projects.move(args.payload).pipe(CommandActor.actAsSession(principal));
          return yield* startup.enqueueCommand(operation).pipe(Effect.catch(failProjectMutation));
        }),
      )
      .handle(
        "movePlan",
        Effect.fn("environment.projects.movePlan")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* authorizeAsMove(args.payload);
          // Once the Hub is ready, as for the move itself.
          const operation = projects
            .movePlan(args.payload)
            .pipe(CommandActor.actAsSession(principal));
          return yield* startup.enqueueCommand(operation).pipe(Effect.catch(failProjectMutation));
        }),
      );
  }),
);
