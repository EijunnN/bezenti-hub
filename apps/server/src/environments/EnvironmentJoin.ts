/**
 * `t3 join`, the Hub's half. The machine sends the SHA-256 of its own credential and a PKCE
 * challenge; the Owner or a User with `environments.registerOwn` approves it, with a strong factor,
 * as their personal machine; the machine asks with its verifier until then. The credential never
 * leaves the machine, and asking again after a lost answer changes nothing.
 */
import type {
  EnvironmentId,
  EnvironmentJoinApproveRequest,
  EnvironmentJoinRequestView,
  EnvironmentJoinStartRequest,
  EnvironmentJoinStatus,
  EnvironmentJoinStatusRequest,
  UserId,
} from "@t3tools/contracts";
import {
  appSignInCallbackUrl,
  appSignInCancelledUrl,
  appSignInRedirectKind,
  isAppSignInCodeChallenge,
  isAppSignInState,
} from "@t3tools/shared/appSignIn";
import { isEnvironmentCredentialHash } from "@t3tools/shared/environmentJoin";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { makeGrantStore, makePkce } from "../auth/pkceGrants.ts";
import * as UserDirectory from "../auth/UserDirectory.ts";
import { base64UrlEncode } from "../auth/utils.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";

/** Long enough for the Owner to reach a browser and sign in. */
const JOIN_REQUEST_TTL_MS = 600_000;
// Starting a request needs no session, so the store is bounded.
const MAX_PENDING_REQUESTS = 200;

type Decision =
  | { readonly _tag: "pending" }
  | { readonly _tag: "denied" }
  | { readonly _tag: "approved"; readonly environmentId: EnvironmentId; readonly name: string };

interface PendingJoin {
  readonly codeChallenge: string;
  readonly credentialHash: string;
  readonly name: string;
  readonly os: string;
  readonly hostname: string;
  readonly redirectUri: string | undefined;
  readonly state: string | undefined;
  readonly requestedAt: string;
  readonly expiresAtMs: number;
  readonly decision: Decision;
}

export class EnvironmentJoinRequestError extends Schema.TaggedError<EnvironmentJoinRequestError>()(
  "EnvironmentJoinRequestError",
  { reason: Schema.Literals(["invalid_redirect_uri", "invalid_code_challenge"]) },
) {}

export class EnvironmentJoinNotSignedInError extends Schema.TaggedError<EnvironmentJoinNotSignedInError>()(
  "EnvironmentJoinNotSignedInError",
  {},
) {
  override get message(): string {
    return "Sign in to this Hub in the browser first.";
  }
}

/** Unknown, expired or already decided otherwise: all look alike. */
export class EnvironmentJoinRequestNotFoundError extends Schema.TaggedError<EnvironmentJoinRequestNotFoundError>()(
  "EnvironmentJoinRequestNotFoundError",
  {},
) {
  override get message(): string {
    return "This registration expired or was already decided. Run `t3 join` again.";
  }
}

/** The verifier is not the one the request was started with. */
export class EnvironmentJoinInvalidGrantError extends Schema.TaggedError<EnvironmentJoinInvalidGrantError>()(
  "EnvironmentJoinInvalidGrantError",
  {},
) {}

type ApproveError =
  | EnvironmentJoinNotSignedInError
  | EnvironmentJoinRequestNotFoundError
  | EnvironmentRegistry.EnvironmentAccessDeniedError
  | UserDirectory.AccountChangeRefusedError
  | UserDirectory.SignInThrottledError
  | UserDirectory.UserDirectoryStorageError
  | EnvironmentRegistry.EnvironmentStorageError
  | EnvironmentAuth.ServerAuthInternalError;

export class EnvironmentJoin extends Context.Service<
  EnvironmentJoin,
  {
    readonly start: (
      input: EnvironmentJoinStartRequest,
    ) => Effect.Effect<{ readonly requestId: string }, EnvironmentJoinRequestError>;
    /** The request, and whether the browser's signed-in User may approve it. */
    readonly view: (
      request: HttpServerRequest.HttpServerRequest,
      requestId: string,
    ) => Effect.Effect<
      EnvironmentJoinRequestView,
      | EnvironmentJoinRequestNotFoundError
      | EnvironmentRegistry.EnvironmentStorageError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    /** Registers the machine; answers where the browser goes next, if anywhere. */
    readonly approve: (
      request: HttpServerRequest.HttpServerRequest,
      input: EnvironmentJoinApproveRequest,
    ) => Effect.Effect<string | null, ApproveError>;
    readonly deny: (
      request: HttpServerRequest.HttpServerRequest,
      requestId: string,
    ) => Effect.Effect<
      string | null,
      | EnvironmentJoinNotSignedInError
      | EnvironmentJoinRequestNotFoundError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    readonly status: (
      input: EnvironmentJoinStatusRequest,
    ) => Effect.Effect<EnvironmentJoinStatus, EnvironmentJoinInvalidGrantError>;
  }
>()("t3/environments/EnvironmentJoin") {}

const make = Effect.gen(function* () {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const userDirectory = yield* UserDirectory.UserDirectory;
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const random = yield* SecureRandom.SecureRandom;
  const pkce = yield* makePkce;
  const requests = yield* makeGrantStore<PendingJoin>(MAX_PENDING_REQUESTS);
  // One decision at a time, so two approvals of one request register it once.
  const decisions = yield* Semaphore.make(1);

  const start: EnvironmentJoin["Service"]["start"] = Effect.fn("EnvironmentJoin.start")(
    function* (input) {
      // Only `t3 join` on the machine itself is sent back to: a loopback port, never a scheme.
      if (
        input.redirectUri !== undefined &&
        (appSignInRedirectKind(input.redirectUri) !== "this-computer" ||
          input.state === undefined ||
          !isAppSignInState(input.state))
      ) {
        return yield* new EnvironmentJoinRequestError({ reason: "invalid_redirect_uri" });
      }
      if (
        !isAppSignInCodeChallenge(input.codeChallenge) ||
        !isEnvironmentCredentialHash(input.credentialHash)
      ) {
        return yield* new EnvironmentJoinRequestError({ reason: "invalid_code_challenge" });
      }
      const now = yield* Clock.currentTimeMillis;
      const requestId = base64UrlEncode(yield* random.randomBytes(24));
      yield* requests.put(
        requestId,
        {
          codeChallenge: input.codeChallenge,
          credentialHash: input.credentialHash,
          name: input.name,
          os: input.os,
          hostname: input.hostname,
          redirectUri: input.redirectUri,
          state: input.state,
          requestedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          expiresAtMs: now + JOIN_REQUEST_TTL_MS,
          decision: { _tag: "pending" },
        },
        now,
      );
      return { requestId };
    },
  );

  const find = Effect.fn("EnvironmentJoin.find")(function* (requestId: string) {
    const found = yield* requests.get(requestId, yield* Clock.currentTimeMillis);
    if (found === undefined) return yield* new EnvironmentJoinRequestNotFoundError({});
    return found;
  });

  // The browser's own cookie, never a token an app holds.
  const browserUser = Effect.fn("EnvironmentJoin.browserUser")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const session = yield* environmentAuth
      .authenticateBrowserSession(request)
      .pipe(
        Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
          Effect.fail(new EnvironmentJoinNotSignedInError({})),
        ),
      );
    if (session.userId === undefined) return yield* new EnvironmentJoinNotSignedInError({});
    return { userId: session.userId as UserId, sessionId: session.sessionId };
  });

  const view: EnvironmentJoin["Service"]["view"] = Effect.fn("EnvironmentJoin.view")(
    function* (request, requestId) {
      const found = yield* find(requestId);
      // A hint for the page only: approving asks again.
      const viewerMayApprove = yield* browserUser(request).pipe(
        Effect.flatMap((user) => registry.authorizeRegister(user.userId)),
        Effect.as(true),
        Effect.catchTags({
          EnvironmentAccessDeniedError: () => Effect.succeed(false),
          EnvironmentJoinNotSignedInError: () => Effect.succeed(undefined),
        }),
      );
      return {
        requestId,
        name: found.name,
        os: found.os,
        hostname: found.hostname,
        requestedAt: found.requestedAt,
        status: found.decision._tag,
        ...(viewerMayApprove === undefined ? {} : { viewerMayApprove }),
      };
    },
  );

  const returnTo = (found: PendingJoin, approved: boolean) =>
    found.redirectUri === undefined || found.state === undefined
      ? null
      : approved
        ? appSignInCallbackUrl(found.redirectUri, "approved", found.state)
        : appSignInCancelledUrl(found.redirectUri, found.state);

  const approve: EnvironmentJoin["Service"]["approve"] = Effect.fn("EnvironmentJoin.approve")(
    function* (request, input) {
      const user = yield* browserUser(request);
      // Who may comes before the factor, so the proof of a User without the right is never checked.
      yield* registry.authorizeRegister(user.userId);
      yield* find(input.requestId);
      yield* userDirectory.confirmStrongFactor(
        { ...user, origin: request.headers.origin ?? "" },
        input.reauth,
      );
      return yield* decisions.withPermits(1)(
        Effect.gen(function* () {
          const found = yield* find(input.requestId);
          if (found.decision._tag === "approved") return returnTo(found, true);
          if (found.decision._tag === "denied") {
            return yield* new EnvironmentJoinRequestNotFoundError({});
          }
          const environmentId = yield* registry.register({
            approvedBy: user.userId,
            name: input.name,
            os: found.os,
            hostname: found.hostname,
            credentialHash: found.credentialHash,
          });
          const now = yield* Clock.currentTimeMillis;
          yield* requests.update(input.requestId, now, (current) => ({
            ...current,
            name: input.name,
            decision: { _tag: "approved", environmentId, name: input.name },
          }));
          return returnTo(found, true);
        }),
      );
    },
  );

  const deny: EnvironmentJoin["Service"]["deny"] = Effect.fn("EnvironmentJoin.deny")(
    function* (request, requestId) {
      yield* browserUser(request);
      return yield* decisions.withPermits(1)(
        Effect.gen(function* () {
          const found = yield* find(requestId);
          if (found.decision._tag === "approved") {
            return yield* new EnvironmentJoinRequestNotFoundError({});
          }
          yield* requests.update(requestId, yield* Clock.currentTimeMillis, (current) => ({
            ...current,
            decision: { _tag: "denied" },
          }));
          return returnTo(found, false);
        }),
      );
    },
  );

  const status: EnvironmentJoin["Service"]["status"] = Effect.fn("EnvironmentJoin.status")(
    function* (input) {
      const found = yield* requests.get(input.requestId, yield* Clock.currentTimeMillis);
      if (found === undefined) return { status: "expired" } as const;
      if (!(yield* pkce.verifies(input.codeVerifier, found.codeChallenge))) {
        return yield* new EnvironmentJoinInvalidGrantError({});
      }
      const { decision } = found;
      if (decision._tag !== "approved") return { status: decision._tag } as const;
      return {
        status: "approved",
        environmentId: decision.environmentId,
        hubEnvironmentId: registry.hubId,
        name: decision.name,
      } as const;
    },
  );

  return EnvironmentJoin.of({ start, view, approve, deny, status });
});

export const layer = Layer.effect(EnvironmentJoin, make);
