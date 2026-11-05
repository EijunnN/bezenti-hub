import {
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, failEnvironmentInternal } from "../auth/http.ts";
import * as SpaceDirectory from "./SpaceDirectory.ts";

const requireUser = Effect.gen(function* () {
  const principal = yield* EnvironmentAuthenticatedPrincipal;
  if (principal.userId === undefined) {
    return yield* new EnvironmentHttpForbiddenError({ message: "Sign in with an account first." });
  }
  return principal.userId;
});

const failStorage = (cause: SpaceDirectory.SpaceDirectoryStorageError) =>
  failEnvironmentInternal("spaces_failed", cause);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "spaces",
  Effect.fnUntraced(function* (handlers) {
    const spaces = yield* SpaceDirectory.SpaceDirectory;
    return handlers
      .handle(
        "list",
        Effect.fn("environment.spaces.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* spaces.view(yield* requireUser).pipe(Effect.catch(failStorage));
        }),
      )
      .handle(
        "createOrganization",
        Effect.fn("environment.spaces.createOrganization")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* spaces.createOrganization(yield* requireUser, args.payload.name).pipe(
            Effect.catchTags({
              SpaceAccessDeniedError: () =>
                Effect.fail(
                  new EnvironmentHttpForbiddenError({
                    message: "Only the Owner creates Organizations.",
                  }),
                ),
              SpaceDirectoryStorageError: failStorage,
            }),
          );
        }),
      );
  }),
);
