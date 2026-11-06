import {
  authScopeRequiredResponse,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  AuthGrantScope,
  EnvironmentAuthInvalidError,
  type EnvironmentAuthInvalidReason,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentInternalError,
  type EnvironmentInternalErrorReason,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  type EnvironmentRequestInvalidReason,
  EnvironmentResourceNotFoundError,
  type EnvironmentResourceNotFoundReason,
  EnvironmentScopeRequiredError,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpConflictError,
  EnvironmentRateLimitedError,
} from "@t3tools/contracts";
import type { AuthEnvironmentScope, DpopFailureReason } from "@t3tools/contracts";
import { parseOAuthScope } from "@t3tools/shared/oauthScope";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as CurrentPrincipal from "./CurrentPrincipal.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as SessionStore from "./SessionStore.ts";
import * as UserDirectory from "./UserDirectory.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import { verifyRequestDpopProof } from "./dpop.ts";
import { requestUrl } from "../requestUrl.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

export const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

const appendDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")),
);

const appendDpopChallengeOnUnauthorized =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (error: EnvironmentAuthInvalidError) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const usesDpop =
      (request.originalUrl.startsWith("/oauth/token") && request.headers.dpop !== undefined) ||
      request.headers.authorization?.startsWith("DPoP ") === true;
    if (usesDpop) {
      yield* appendDpopChallengeHeader;
    }
    return yield* error;
  });

const currentEnvironmentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

export const annotateEnvironmentRequest =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (endpoint: string) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    const traceId = yield* currentEnvironmentTraceId;

    yield* Effect.addFinalizer((exit) =>
      exit._tag === "Failure"
        ? Effect.logWarning("environment api request failed", {
            endpoint,
            traceId,
            errorTag: causeErrorTag(exit.cause),
            cause: exit.cause,
          })
        : Effect.void,
    );
    yield* Effect.annotateLogsScoped({ "environment.endpoint": endpoint, traceId });
    yield* Effect.annotateCurrentSpan({
      "environment.endpoint": endpoint,
      "http.request.method": request.method,
      "url.path": url._tag === "Some" ? url.value.pathname : "unknown",
    });
  });

export function failEnvironmentAuthInvalid(
  reason: EnvironmentAuthInvalidReason,
  dpopFailureReason?: DpopFailureReason,
) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentAuthInvalidError({
          code: "auth_invalid",
          reason,
          ...(dpopFailureReason === undefined ? {} : { dpopFailureReason }),
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentInvalidRequest(reason: EnvironmentRequestInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentRequestInvalidError({ code: "invalid_request", reason, traceId })),
    ),
  );
}

export function failEnvironmentScopeRequired(requiredScope: AuthEnvironmentScope) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentScopeRequiredError({
          code: "insufficient_scope",
          ...authScopeRequiredResponse(requiredScope),
          traceId,
        }),
      ),
    ),
  );
}

function failEnvironmentOperationForbidden(reason: "current_session_revoke_not_allowed") {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentOperationForbiddenError({
          code: "operation_forbidden",
          reason,
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentNotFound(reason: EnvironmentResourceNotFoundReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentResourceNotFoundError({ code: "not_found", reason, traceId })),
    ),
  );
}

/**
 * `<img>` and WebSocket cannot set headers, so media routes (device hub, preview stream)
 * authenticate the way the `/ws` upgrade does: a cookie for browser sessions, or a short-lived
 * `wsTicket` minted over authenticated HTTP for bearer and DPoP clients.
 */
export const authenticateMediaRequest =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (requiredScope: AuthEnvironmentScope) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request, "media").pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (EnvironmentAuth.isServerAuthCredentialError(error)) {
            return yield* failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            );
          }
          return yield* failEnvironmentInternal("internal_error", error);
        }),
      ),
    );
    if (!session.scopes.includes(requiredScope)) {
      return yield* failEnvironmentScopeRequired(requiredScope);
    }
    return session;
  });

export const failEnvironmentInternal =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (reason: EnvironmentInternalErrorReason, error?: unknown) {
    const traceId = yield* currentEnvironmentTraceId;
    if (error !== undefined) {
      yield* Effect.logError("environment api operation failed", {
        reason,
        traceId,
        cause: error,
      });
    }
    return yield* new EnvironmentInternalError({ code: "internal_error", reason, traceId });
  });

const SESSION_COOKIE_ATTRIBUTES = { httpOnly: true, path: "/", sameSite: "lax" } as const;

const appendCookies = (cookies: ReturnType<typeof Cookies.set>) =>
  Effect.fromResult(cookies).pipe(
    Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")),
    Effect.flatMap((cookies) =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.mergeCookies(response, cookies)),
      ),
    ),
  );

/** Session cookies are `Secure` whenever the client reached the server over HTTPS. */
const sessionCookieAttributes = HttpServerRequest.HttpServerRequest.pipe(
  Effect.map((request) =>
    request.protocol === "https"
      ? { ...SESSION_COOKIE_ATTRIBUTES, secure: true }
      : SESSION_COOKIE_ATTRIBUTES,
  ),
);

export const appendSessionCookie = (
  cookieName: string,
  token: string,
  expiresAt: DateTime.DateTime,
) =>
  Effect.flatMap(sessionCookieAttributes, (attributes) =>
    appendCookies(
      Cookies.set(Cookies.empty, cookieName, token, {
        ...attributes,
        expires: DateTime.toDate(expiresAt),
      }),
    ),
  );

const expireSessionCookies = (cookieNames: ReadonlyArray<string>) =>
  Effect.flatMap(sessionCookieAttributes, (attributes) =>
    Effect.forEach(
      cookieNames,
      (cookieName) => appendCookies(Cookies.expireCookie(Cookies.empty, cookieName, attributes)),
      { discard: true },
    ),
  );

const userSignInFailures = {
  ServerAuthInvalidOriginError: () => failEnvironmentInvalidRequest("invalid_origin"),
  ServerAuthInsecureTransportError: () => failEnvironmentInvalidRequest("insecure_transport"),
  ServerAuthInvalidCredentialError: () => failEnvironmentAuthInvalid("invalid_credential"),
};

const failUserSignInInternal = (error: EnvironmentAuth.ServerAuthInternalError) =>
  failEnvironmentInternal("browser_session_issuance_failed", error);

const failUserSignIn = <A, R>(
  effect: Effect.Effect<
    A,
    | EnvironmentAuth.ServerAuthInvalidOriginError
    | EnvironmentAuth.ServerAuthInvalidCredentialError
    | EnvironmentAuth.ServerAuthInsecureTransportError
    | EnvironmentAuth.ServerAuthInternalError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags(userSignInFailures),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, failUserSignInInternal),
  );

const failOwnerBootstrap = <A, R>(
  effect: Effect.Effect<
    A,
    | EnvironmentAuth.ServerAuthOwnerAlreadyClaimedError
    | EnvironmentAuth.ServerAuthInvalidOriginError
    | EnvironmentAuth.ServerAuthInvalidCredentialError
    | EnvironmentAuth.ServerAuthInsecureTransportError
    | EnvironmentAuth.ServerAuthInternalError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      ...userSignInFailures,
      ServerAuthOwnerAlreadyClaimedError: (error) =>
        Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
    }),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, failUserSignInInternal),
  );

/** The signed-in User managing their own account; pairing-link sessions have none. */
const requireAccountActor = Effect.gen(function* () {
  const principal = yield* EnvironmentAuthenticatedPrincipal;
  if (principal.userId === undefined) {
    return yield* new EnvironmentHttpForbiddenError({
      message: "Sign in with an account to manage it.",
    });
  }
  const request = yield* HttpServerRequest.HttpServerRequest;
  // A passkey step-up must match the origin its challenge was issued to, which was checked then.
  return {
    userId: principal.userId,
    sessionId: principal.sessionId,
    origin: request.headers.origin ?? "",
  } satisfies UserDirectory.AccountActor;
});

const failThrottled = (error: UserDirectory.SignInThrottledError) =>
  Effect.fail(
    new EnvironmentRateLimitedError({
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    }),
  );

const accountChangeFailures = {
  SignInThrottledError: failThrottled,
  AccountChangeRefusedError: (error: UserDirectory.AccountChangeRefusedError) =>
    Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
  UserDirectoryStorageError: (error: UserDirectory.UserDirectoryStorageError) =>
    failEnvironmentInternal("internal_error", error),
};

const failAccountChange = <A, R>(
  effect: Effect.Effect<
    A,
    | UserDirectory.AccountChangeRefusedError
    | UserDirectory.SignInThrottledError
    | UserDirectory.UserDirectoryStorageError,
    R
  >,
) => effect.pipe(Effect.catchTags(accountChangeFailures));

export const requireEnvironmentScope = Effect.fn("environment.auth.requireScope")(function* (
  scope: AuthEnvironmentScope,
) {
  const session = yield* EnvironmentAuthenticatedPrincipal;
  if (!session.scopes.has(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
  return session;
});

export const layerAuthenticatedAuth = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        return yield* httpEffect.pipe(
          Effect.provideService(
            EnvironmentAuthenticatedPrincipal,
            CurrentPrincipal.fromSession(session),
          ),
        );
      }).pipe(Effect.catchTags({ EnvironmentAuthInvalidError: appendDpopChallengeOnUnauthorized }));
  }),
);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const userDirectory = yield* UserDirectory.UserDirectory;

    return handlers
      .handle(
        "passwordSignIn",
        Effect.fn("environment.auth.passwordSignIn")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const result = yield* serverAuth
            .signInWithPassword(request, args.payload, deriveAuthClientMetadata({ request }))
            .pipe(
              Effect.catchTags({
                ServerAuthInvalidCredentialError:
                  userSignInFailures.ServerAuthInvalidCredentialError,
                ServerAuthInsecureTransportError:
                  userSignInFailures.ServerAuthInsecureTransportError,
                SignInThrottledError: failThrottled,
              }),
              Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, failUserSignInInternal),
            );
          yield* appendCredentialResponseHeaders;
          if ("sessionToken" in result) {
            yield* appendSessionCookie(
              sessions.cookieName,
              result.sessionToken,
              result.response.expiresAt,
            );
          }
          return result.response;
        }),
      )
      .handle(
        "totpSignIn",
        Effect.fn("environment.auth.totpSignIn")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { response, sessionToken } = yield* serverAuth
            .signInWithTotp(request, args.payload, deriveAuthClientMetadata({ request }))
            .pipe(
              Effect.catchTags({
                ServerAuthInvalidCredentialError:
                  userSignInFailures.ServerAuthInvalidCredentialError,
                ServerAuthInsecureTransportError:
                  userSignInFailures.ServerAuthInsecureTransportError,
                SignInThrottledError: failThrottled,
              }),
              Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, failUserSignInInternal),
            );
          yield* appendSessionCookie(sessions.cookieName, sessionToken, response.expiresAt);
          yield* appendCredentialResponseHeaders;
          return response;
        }),
      )
      .handle(
        "account",
        Effect.fn("environment.auth.account")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const actor = yield* requireAccountActor;
          return yield* userDirectory.getAccount(actor.userId).pipe(failAccountChange);
        }),
      )
      .handle(
        "setPassword",
        Effect.fn("environment.auth.setPassword")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* userDirectory.setPassword(yield* requireAccountActor, args.payload).pipe(
            Effect.catchTags({
              ...accountChangeFailures,
              LoginNameTakenError: (error) =>
                Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
            }),
          );
        }),
      )
      .handle(
        "removePassword",
        Effect.fn("environment.auth.removePassword")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* userDirectory
            .removePassword(yield* requireAccountActor, args.payload.reauth)
            .pipe(failAccountChange);
        }),
      )
      .handle(
        "startTotpEnrollment",
        Effect.fn("environment.auth.startTotpEnrollment")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* appendCredentialResponseHeaders;
          const actor = yield* requireAccountActor;
          return yield* userDirectory.startTotpEnrollment(actor.userId).pipe(failAccountChange);
        }),
      )
      .handle(
        "confirmTotpEnrollment",
        Effect.fn("environment.auth.confirmTotpEnrollment")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* userDirectory
            .confirmTotpEnrollment(yield* requireAccountActor, args.payload)
            .pipe(failAccountChange);
        }),
      )
      .handle(
        "removeTotp",
        Effect.fn("environment.auth.removeTotp")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* userDirectory
            .removeTotp(yield* requireAccountActor, args.payload.reauth)
            .pipe(failAccountChange);
        }),
      )
      .handle(
        "resetLinkStatus",
        Effect.fn("environment.auth.resetLinkStatus")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            return yield* userDirectory.getResetLinkStatus(args.payload.token);
          },
          Effect.catchTags({
            UserDirectoryStorageError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "resetLinkRegistration",
        Effect.fn("environment.auth.resetLinkRegistration")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* serverAuth
            .beginResetLinkRegistration(request, args.payload.token)
            .pipe(failUserSignIn);
        }),
      )
      .handle(
        "redeemResetLink",
        Effect.fn("environment.auth.redeemResetLink")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { response, sessionToken } = yield* serverAuth
            .redeemResetLink(request, args.payload, deriveAuthClientMetadata({ request }))
            .pipe(failUserSignIn);
          yield* appendSessionCookie(sessions.cookieName, sessionToken, response.expiresAt);
          yield* appendCredentialResponseHeaders;
          return response;
        }),
      )
      .handle(
        "session",
        Effect.fn("environment.auth.session")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const result = yield* serverAuth.getSessionState(request);
            const credential = EnvironmentAuth.selectRequestCredential(
              request,
              sessions.cookieName,
              sessions.legacyCookieName,
            );
            // Re-sent on every check so a sliding session keeps its cookie as long as its row.
            if (
              (credential?.source === "cookie" || credential?.source === "legacy-cookie") &&
              result.authenticated &&
              result.sessionMethod === "browser-session-cookie" &&
              result.expiresAt
            ) {
              yield* appendSessionCookie(sessions.cookieName, credential.token, result.expiresAt);
              yield* appendCredentialResponseHeaders;
            }
            return result;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        ),
      )
      .handle(
        "browserSession",
        Effect.fn("environment.auth.browserSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const previousCredential = EnvironmentAuth.selectRequestCredential(
              request,
              sessions.cookieName,
              sessions.legacyCookieName,
            );
            const result = yield* serverAuth.createBrowserSession(
              args.payload.credential,
              deriveAuthClientMetadata({ request }),
              previousCredential &&
                EnvironmentAuth.isBrowserCookieCredential(previousCredential.source)
                ? previousCredential.token
                : undefined,
            );
            const cookieName = result.cookieName ?? sessions.cookieName;
            const attributes = yield* sessionCookieAttributes;
            const selectedCookie = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, cookieName, result.sessionToken, {
                ...attributes,
                expires: DateTime.toDate(result.response.expiresAt),
              }),
            ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")));
            const sessionCookies = result.expireNormalCookie
              ? yield* Effect.fromResult(
                  Cookies.expireCookie(selectedCookie, sessions.cookieName, attributes),
                ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")))
              : selectedCookie;

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          Effect.catchTags({
            ServerAuthInsecureTransportError: userSignInFailures.ServerAuthInsecureTransportError,
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("browser_session_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "token",
        Effect.fn("environment.auth.token")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const requestedScopes =
              args.payload.scope === undefined
                ? undefined
                : (parseOAuthScope(args.payload.scope)?.filter(Schema.is(AuthGrantScope)) ?? null);
            if (requestedScopes === null || requestedScopes?.length === 0) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            const proofKeyThumbprint = args.headers.dpop
              ? yield* verifyRequestDpopProof({ request }).pipe(
                  Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
                    appendDpopChallengeHeader.pipe(
                      Effect.andThen(
                        failEnvironmentAuthInvalid(
                          "invalid_credential",
                          EnvironmentAuth.serverAuthDpopFailureReason(error),
                        ),
                      ),
                    ),
                  ),
                  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
                    failEnvironmentInternal("access_token_issuance_failed", error),
                  ),
                )
              : undefined;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
              args.payload.subject_token,
              requestedScopes,
              deriveAuthClientMetadata({
                request,
                presented: {
                  ...(args.payload.client_label ? { label: args.payload.client_label } : {}),
                  ...(args.payload.client_device_type
                    ? { deviceType: args.payload.client_device_type }
                    : {}),
                  ...(args.payload.client_os ? { os: args.payload.client_os } : {}),
                },
              }),
              proofKeyThumbprint ? { proofKeyThumbprint } : undefined,
            );
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchTags({
            ServerAuthInsecureTransportError: userSignInFailures.ServerAuthInsecureTransportError,
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthInvalidRequestError, (error) =>
            failEnvironmentInvalidRequest(EnvironmentAuth.serverAuthInvalidRequestReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("access_token_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "webSocketTicket",
        Effect.fn("environment.auth.webSocketTicket")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.issueWebSocketTicket(session);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("websocket_ticket_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "webSocketTicketFor",
        Effect.fn("environment.auth.webSocketTicketFor")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.issueWebSocketTicket(session, { use: args.params.use });
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("websocket_ticket_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingCredential",
        Effect.fn("environment.auth.pairingCredential")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const delegatedScopes = args.payload.scopes ?? AuthStandardClientScopes;
            if (
              delegatedScopes.length === 0 ||
              new Set<AuthEnvironmentScope>(delegatedScopes).size !== delegatedScopes.length
            ) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            for (const delegatedScope of delegatedScopes) {
              if (!session.scopes.has(delegatedScope)) {
                return yield* failEnvironmentScopeRequired(delegatedScope);
              }
            }
            return yield* serverAuth.issuePairingCredential(args.payload, session.userId);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_credential_issuance_failed", error),
          ),
          Effect.catchTags({
            ManagedPolicyRefusedError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
          }),
        ),
      )
      .handle(
        "revokePairingLink",
        Effect.fn("environment.auth.revokePairingLink")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokePairingLink(args.payload.id, session);
            return { revoked };
          },
          Effect.catchTags({
            ServerAuthNotYourSessionError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_link_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "revokeClient",
        Effect.fn("environment.auth.revokeClient")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokeClientSession(session, args.payload.sessionId);
            return { revoked };
          },
          Effect.catchTags({
            ServerAuthForbiddenOperationError: () =>
              failEnvironmentOperationForbidden("current_session_revoke_not_allowed"),
            ServerAuthNotYourSessionError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "ownerBootstrapStatus",
        Effect.fn("environment.auth.ownerBootstrapStatus")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            return yield* serverAuth.getOwnerBootstrapStatus(args.payload.credential);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("bootstrap_validation_failed", error),
          ),
        ),
      )
      .handle(
        "ownerRegistration",
        Effect.fn("environment.auth.ownerRegistration")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* serverAuth
            .beginOwnerBootstrap(request, args.payload)
            .pipe(failOwnerBootstrap);
        }),
      )
      .handle(
        "ownerBootstrap",
        Effect.fn("environment.auth.ownerBootstrap")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { result, sessionToken } = yield* serverAuth
            .completeOwnerBootstrap(request, args.payload, deriveAuthClientMetadata({ request }))
            .pipe(failOwnerBootstrap);
          yield* appendSessionCookie(sessions.cookieName, sessionToken, result.session.expiresAt);
          yield* appendCredentialResponseHeaders;
          return result;
        }),
      )
      .handle(
        "passkeyChallenge",
        Effect.fn("environment.auth.passkeyChallenge")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* serverAuth.beginPasskeySignIn(request).pipe(failUserSignIn);
        }),
      )
      .handle(
        "passkeySignIn",
        Effect.fn("environment.auth.passkeySignIn")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { response, sessionToken } = yield* serverAuth
            .completePasskeySignIn(request, args.payload, deriveAuthClientMetadata({ request }))
            .pipe(failUserSignIn);
          yield* appendSessionCookie(sessions.cookieName, sessionToken, response.expiresAt);
          yield* appendCredentialResponseHeaders;
          return response;
        }),
      )
      .handle(
        "recoveryCodeSignIn",
        Effect.fn("environment.auth.recoveryCodeSignIn")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { response, sessionToken } = yield* serverAuth
            .signInWithRecoveryCode(
              request,
              args.payload.code,
              deriveAuthClientMetadata({ request }),
            )
            .pipe(failUserSignIn);
          yield* appendSessionCookie(sessions.cookieName, sessionToken, response.expiresAt);
          yield* appendCredentialResponseHeaders;
          return response;
        }),
      )
      .handle(
        "signOut",
        Effect.fn("environment.auth.signOut")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const signedOut = yield* serverAuth.signOut(request);
            yield* expireSessionCookies(
              sessions.legacyCookieName === undefined
                ? [sessions.cookieName]
                : [sessions.cookieName, sessions.legacyCookieName],
            );
            return { signedOut };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "revokeOtherClients",
        Effect.fn("environment.auth.revokeOtherClients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revokedCount = yield* serverAuth.revokeOtherClientSessions(session);
            return { revokedCount };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      );
  }),
);
