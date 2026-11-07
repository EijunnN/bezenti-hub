import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentModeChangeRefusedError,
  EnvironmentRateLimitedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { isLoopbackClientAddress } from "../auth/clientConnection.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  appendCredentialResponseHeaders,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as EnvironmentJoin from "./EnvironmentJoin.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";

const requireUser = Effect.fn("Environments.requireUser")(function* (scope: AuthEnvironmentScope) {
  const principal = yield* requireEnvironmentScope(scope);
  if (principal.userId === undefined) {
    return yield* new EnvironmentHttpForbiddenError({ message: "Sign in with an account first." });
  }
  return principal.userId;
});

/**
 * The Environment credential crosses only HTTPS, or plain HTTP from this same machine. Behind a
 * trusted proxy the scheme and client are the ones it forwarded.
 */
export const isSecureEnvironmentTransport = (request: HttpServerRequest.HttpServerRequest) =>
  request.protocol === "https" ||
  isLoopbackClientAddress(Option.getOrUndefined(request.remoteAddress));

/** The token of an `Authorization: Bearer` header; the scheme is case-insensitive (RFC 9110). */
export const bearerOf = (authorization: string | undefined) =>
  /^bearer\s+(\S+)\s*$/iu.exec(authorization ?? "")?.[1];

const failForbidden = (error: { readonly message: string }) =>
  Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message }));
const failStorage = (cause: unknown) => failEnvironmentInternal("environments_failed", cause);

const handlers = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "environments",
  Effect.fnUntraced(function* (handlers) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const join = yield* EnvironmentJoin.EnvironmentJoin;
    return handlers
      .handle(
        "list",
        Effect.fn("environment.environments.list")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const viewer = yield* requireUser(AuthOrchestrationReadScope);
          const environments = yield* registry.list(viewer).pipe(
            Effect.catchTags({
              EnvironmentAccessDeniedError: failForbidden,
              EnvironmentStorageError: failStorage,
            }),
          );
          return { environments };
        }),
      )
      .handle(
        "rename",
        Effect.fn("environment.environments.rename")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* registry
            .rename({
              actorUserId: yield* requireUser(AuthAccessWriteScope),
              environmentId: args.payload.environmentId,
              name: args.payload.name,
            })
            .pipe(
              Effect.catchTags({
                EnvironmentAccessDeniedError: failForbidden,
                EnvironmentNotFoundError: () => failEnvironmentNotFound("environment_not_found"),
                EnvironmentStorageError: failStorage,
              }),
            );
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.environments.remove")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actorUserId = yield* requireUser(AuthAccessWriteScope);
          const environments = yield* registry
            .remove({ actorUserId, environmentId: args.payload.environmentId })
            .pipe(
              Effect.andThen(registry.list(actorUserId)),
              Effect.catchTags({
                EnvironmentAccessDeniedError: failForbidden,
                EnvironmentNotFoundError: () => failEnvironmentNotFound("environment_not_found"),
                EnvironmentStorageError: failStorage,
              }),
            );
          return { environments };
        }),
      )
      .handle(
        "changeMode",
        Effect.fn("environment.environments.changeMode")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* registry
            .changeMode({
              actorUserId: yield* requireUser(AuthAccessWriteScope),
              environmentId: args.payload.environmentId,
              mode: args.payload.mode,
              spaceId: args.payload.spaceId,
            })
            .pipe(
              Effect.catchTags({
                EnvironmentAccessDeniedError: failForbidden,
                EnvironmentNotFoundError: () => failEnvironmentNotFound("environment_not_found"),
                EnvironmentModeChangeRefusedError: (error) =>
                  Effect.fail(
                    new EnvironmentModeChangeRefusedError({
                      message: error.message,
                      threads: error.threads,
                    }),
                  ),
                EnvironmentStorageError: failStorage,
              }),
            );
        }),
      )
      .handle(
        "start",
        Effect.fn("environment.environments.start")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* registry
            .startSandbox({
              actorUserId: yield* requireUser(AuthAccessWriteScope),
              environmentId: args.payload.environmentId,
            })
            .pipe(
              Effect.catchTags({
                EnvironmentAccessDeniedError: failForbidden,
                EnvironmentNotFoundError: () => failEnvironmentNotFound("environment_not_found"),
                EnvironmentStorageError: failStorage,
              }),
            );
        }),
      )
      .handle(
        "startJoin",
        Effect.fn("environment.environments.startJoin")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* join.start(args.payload).pipe(
            Effect.catchTags({
              EnvironmentJoinRequestError: (error) => failEnvironmentInvalidRequest(error.reason),
            }),
          );
        }),
      )
      .handle(
        "joinStatus",
        Effect.fn("environment.environments.joinStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* appendCredentialResponseHeaders;
          return yield* join.status(args.payload).pipe(
            Effect.catchTags({
              EnvironmentJoinInvalidGrantError: () =>
                failEnvironmentAuthInvalid("invalid_credential"),
            }),
          );
        }),
      )
      .handle(
        "joinRequest",
        Effect.fn("environment.environments.joinRequest")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* join.view(request, args.payload.requestId).pipe(
            Effect.catchTags({
              EnvironmentJoinRequestNotFoundError: () =>
                failEnvironmentNotFound("join_request_not_found"),
            }),
          );
        }),
      )
      .handle(
        "approveJoin",
        Effect.fn("environment.environments.approveJoin")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            return { redirectTo: yield* join.approve(request, args.payload) };
          },
          Effect.catchTags({
            EnvironmentJoinNotSignedInError: () => failEnvironmentAuthInvalid("missing_credential"),
            EnvironmentJoinRequestNotFoundError: () =>
              failEnvironmentNotFound("join_request_not_found"),
            EnvironmentAccessDeniedError: failForbidden,
            AccountChangeRefusedError: failForbidden,
            SignInThrottledError: (error) =>
              Effect.fail(
                new EnvironmentRateLimitedError({
                  message: error.message,
                  retryAfterSeconds: error.retryAfterSeconds,
                }),
              ),
            UserDirectoryStorageError: failStorage,
            EnvironmentStorageError: failStorage,
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, failStorage),
        ),
      )
      .handle(
        "denyJoin",
        Effect.fn("environment.environments.denyJoin")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            return { redirectTo: yield* join.deny(request, args.payload.requestId) };
          },
          Effect.catchTags({
            EnvironmentJoinNotSignedInError: () => failEnvironmentAuthInvalid("missing_credential"),
            EnvironmentJoinRequestNotFoundError: () =>
              failEnvironmentNotFound("join_request_not_found"),
            EnvironmentAccessDeniedError: failForbidden,
            EnvironmentStorageError: failStorage,
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, failStorage),
        ),
      )
      .handle(
        "confirmJoin",
        Effect.fn("environment.environments.confirmJoin")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* appendCredentialResponseHeaders;
          return yield* join.confirm(args.payload).pipe(
            Effect.catchTags({
              EnvironmentJoinInvalidGrantError: () =>
                failEnvironmentAuthInvalid("invalid_credential"),
              EnvironmentJoinRequestNotFoundError: () =>
                failEnvironmentNotFound("join_request_not_found"),
              EnvironmentAccessDeniedError: failForbidden,
              EnvironmentStorageError: failStorage,
            }),
          );
        }),
      )
      .handle(
        "leave",
        Effect.fn("environment.environments.leave")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!isSecureEnvironmentTransport(request)) {
            return yield* failEnvironmentInvalidRequest("insecure_transport");
          }
          const removed = yield* registry
            .leave(bearerOf(args.headers.authorization))
            .pipe(Effect.catchTags({ EnvironmentStorageError: failStorage }));
          if (!removed) return yield* failEnvironmentAuthInvalid("invalid_credential");
          return { removed };
        }),
      );
  }),
);

export const layer = handlers.pipe(Layer.provide(EnvironmentJoin.layer));
