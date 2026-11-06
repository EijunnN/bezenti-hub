import {
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentNotFound,
} from "../auth/http.ts";
import * as SpaceDirectory from "./SpaceDirectory.ts";

const requireUser = Effect.gen(function* () {
  const principal = yield* EnvironmentAuthenticatedPrincipal;
  if (principal.userId === undefined) {
    return yield* new EnvironmentHttpForbiddenError({ message: "Sign in with an account first." });
  }
  return principal.userId;
});

const failDenied = (error: SpaceDirectory.SpaceAccessDeniedError) =>
  Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message }));
const failStorage = (cause: SpaceDirectory.SpaceDirectoryStorageError) =>
  failEnvironmentInternal("installation_users_failed", cause);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "installationUsers",
  Effect.fnUntraced(function* (handlers) {
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    return handlers
      .handle(
        "list",
        Effect.fn("environment.installationUsers.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const users = yield* spaces.listUsers(yield* requireUser).pipe(
            Effect.catchTags({
              SpaceAccessDeniedError: failDenied,
              SpaceDirectoryStorageError: failStorage,
            }),
          );
          return { users };
        }),
      )
      .handle(
        "setPermission",
        Effect.fn("environment.installationUsers.setPermission")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* spaces
            .setInstallationPermission({
              actorUserId: yield* requireUser,
              userId: args.params.userId,
              permission: args.payload.permission,
              granted: args.payload.granted,
            })
            .pipe(
              Effect.catchTags({
                SpaceAccessDeniedError: failDenied,
                InstallationUserNotFoundError: () => failEnvironmentNotFound("user_not_found"),
                SpaceDirectoryStorageError: failStorage,
              }),
            );
        }),
      );
  }),
);
