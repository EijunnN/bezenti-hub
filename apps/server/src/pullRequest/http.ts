import {
  AuthOrchestrationReadScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  PullRequestUnavailableError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { authorizeSessionAsRpc } from "../auth/RpcAuthorization.ts";
import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import * as PullRequestService from "./PullRequestService.ts";

// Large patches benefit from HTTP compression and flow control.
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "pullRequests",
  Effect.fnUntraced(function* (handlers) {
    const pullRequests = yield* PullRequestService.PullRequestService;
    const spaceVisibility = yield* SpaceVisibility.SpaceVisibility;
    return handlers.handle(
      "diff",
      Effect.fn("environment.pullRequests.diff")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        const principal = yield* EnvironmentAuthenticatedPrincipal;
        const visibility = yield* spaceVisibility.of(principal.userId);
        // The rule of reading a change request's files over the socket. A hidden Project, like a
        // missing one, has no checkout to read the change request from.
        yield* authorizeSessionAsRpc(
          WS_METHODS.pullRequestsDiffFileContents,
          args.payload,
          principal,
        ).pipe(
          Effect.catch(() =>
            Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" })),
          ),
        );
        return yield* pullRequests
          .diff(args.payload)
          .pipe(Effect.provideService(SpaceVisibility.RequestVisibility, visibility));
      }),
    );
  }),
);
