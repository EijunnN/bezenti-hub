import { EnvironmentHttpForbiddenError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";

import {
  isPrivateClientAddress,
  type TrustedProxies,
  withClientConnection,
} from "./clientConnection.ts";
import { OwnerPresence } from "./OwnerPresence.ts";
import * as UserDirectory from "./UserDirectory.ts";

/**
 * Every route, WebSocket upgrades included, sees the client's request (clientConnection). Until
 * an Owner exists only private clients get in, judged by the resolved address the socket filter
 * cannot see; a public client re-reads the directory. `prepare` names a test request's peer.
 */
export const layerClientAdmission = (
  trustedProxies: TrustedProxies,
  prepare: (request: HttpServerRequest.HttpServerRequest) => HttpServerRequest.HttpServerRequest = (
    request,
  ) => request,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const users = yield* UserDirectory.UserDirectory;
      const presence = yield* OwnerPresence;
      const ownerExists = Effect.suspend(() =>
        presence.exists()
          ? Effect.succeed(true)
          : users.hasOwner().pipe(
              Effect.tap((exists) => (exists ? Effect.sync(presence.markExists) : Effect.void)),
              Effect.catch((cause) =>
                Effect.logWarning("Could not read whether the Installation has an Owner.", {
                  cause,
                }).pipe(Effect.as(false)),
              ),
            ),
      );
      return HttpRouter.middleware(
        (httpApp) =>
          Effect.gen(function* () {
            const request = withClientConnection(
              prepare(yield* HttpServerRequest.HttpServerRequest),
              trustedProxies,
            );
            if (
              !isPrivateClientAddress(Option.getOrUndefined(request.remoteAddress)) &&
              !(yield* ownerExists)
            ) {
              return yield* HttpServerRespondable.toResponse(
                new EnvironmentHttpForbiddenError({
                  message:
                    "This Installation is not open to the internet until its Owner account exists.",
                }),
              );
            }
            return yield* Effect.provideService(
              httpApp,
              HttpServerRequest.HttpServerRequest,
              request,
            );
          }),
        { global: true },
      );
    }),
  );
