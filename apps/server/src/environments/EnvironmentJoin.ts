/**
 * `t3 join`, the Hub's half. The «Register this machine» page approves with the Owner's browser
 * session and a strong factor in the same request, and answers a one-time code bound to the
 * machine's PKCE challenge and loopback redirect, as app sign-in does. The machine redeems the
 * code for its Environment credential; the row and its audit entry are written then.
 */
import type {
  EnvironmentId,
  EnvironmentJoinApproveRequest,
  EnvironmentJoinTokenRequest,
  EnvironmentJoinTokenResult,
  UserId,
} from "@t3tools/contracts";
import {
  appSignInCallbackUrl,
  appSignInRedirectKind,
  isAppSignInCodeChallenge,
  isAppSignInCodeVerifier,
  isAppSignInState,
} from "@t3tools/shared/appSignIn";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as UserDirectory from "../auth/UserDirectory.ts";
import { base64UrlEncode, timingSafeEqualBase64Url } from "../auth/utils.ts";
import * as EnvironmentRegistry from "./EnvironmentRegistry.ts";

/** Long enough for the browser to hand the code to `t3 join`, short enough to be stale if leaked. */
const JOIN_CODE_TTL_MS = 60_000;

interface PendingJoin {
  readonly approvedBy: UserId;
  readonly name: string;
  readonly os: string;
  readonly hostname: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly expiresAtMs: number;
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

/** Unknown, used, expired, or presented with the wrong verifier or redirect: all look alike. */
export class EnvironmentJoinInvalidGrantError extends Schema.TaggedError<EnvironmentJoinInvalidGrantError>()(
  "EnvironmentJoinInvalidGrantError",
  {},
) {
  override get message(): string {
    return "The registration code is invalid or expired. Run `t3 join` again.";
  }
}

export class EnvironmentJoin extends Context.Service<
  EnvironmentJoin,
  {
    /** Approves with the request's browser session and answers the redirect back to `t3 join`. */
    readonly approve: (
      request: HttpServerRequest.HttpServerRequest,
      input: EnvironmentJoinApproveRequest,
    ) => Effect.Effect<
      string,
      | EnvironmentJoinRequestError
      | EnvironmentJoinNotSignedInError
      | EnvironmentRegistry.EnvironmentAccessDeniedError
      | UserDirectory.AccountChangeRefusedError
      | UserDirectory.SignInThrottledError
      | UserDirectory.UserDirectoryStorageError
      | EnvironmentRegistry.EnvironmentStorageError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    readonly redeem: (
      input: EnvironmentJoinTokenRequest,
    ) => Effect.Effect<
      EnvironmentJoinTokenResult,
      | EnvironmentJoinInvalidGrantError
      | EnvironmentRegistry.EnvironmentAccessDeniedError
      | EnvironmentRegistry.EnvironmentStorageError
    >;
  }
>()("t3/environments/EnvironmentJoin") {}

const make = Effect.gen(function* () {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const userDirectory = yield* UserDirectory.UserDirectory;
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  // Keyed by the code's SHA-256, so the codes themselves are never held.
  const codes = yield* Ref.make<ReadonlyMap<string, PendingJoin>>(new Map());

  const sha256 = (value: string) =>
    digester.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(
      Effect.orDie,
      Effect.map((digest) => base64UrlEncode(digest)),
    );

  const approve: EnvironmentJoin["Service"]["approve"] = Effect.fn("EnvironmentJoin.approve")(
    function* (request, input) {
      // Only `t3 join` on the machine itself gets the code: a loopback port, never a scheme.
      if (appSignInRedirectKind(input.redirectUri) !== "this-computer") {
        return yield* new EnvironmentJoinRequestError({ reason: "invalid_redirect_uri" });
      }
      if (!isAppSignInCodeChallenge(input.codeChallenge) || !isAppSignInState(input.state)) {
        return yield* new EnvironmentJoinRequestError({ reason: "invalid_code_challenge" });
      }
      // The browser's own cookie, never a token an app holds.
      const session = yield* environmentAuth
        .authenticateBrowserSession(request)
        .pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
            Effect.fail(new EnvironmentJoinNotSignedInError({})),
          ),
        );
      if (session.userId === undefined) return yield* new EnvironmentJoinNotSignedInError({});
      // Who may comes before the factor, so a Member's proof is never even checked.
      if (!(yield* registry.mayRegister(session.userId))) {
        return yield* new EnvironmentRegistry.EnvironmentAccessDeniedError({
          reason: "owner-only",
        });
      }
      yield* userDirectory.confirmStrongFactor(
        {
          userId: session.userId,
          sessionId: session.sessionId,
          origin: request.headers.origin ?? "",
        },
        input.reauth,
      );
      const now = yield* Clock.currentTimeMillis;
      const code = base64UrlEncode(yield* random.randomBytes(32));
      const key = yield* sha256(code);
      const pending: PendingJoin = {
        approvedBy: session.userId,
        name: input.name,
        os: input.os,
        hostname: input.hostname,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        expiresAtMs: now + JOIN_CODE_TTL_MS,
      };
      yield* Ref.update(codes, (current) => {
        const next = new Map(
          Array.from(current).filter(([, existing]) => existing.expiresAtMs > now),
        );
        next.set(key, pending);
        return next;
      });
      return appSignInCallbackUrl(input.redirectUri, code, input.state);
    },
  );

  const pkceVerifies = (verifier: string, challenge: string) =>
    isAppSignInCodeVerifier(verifier)
      ? sha256(verifier).pipe(Effect.map((digest) => timingSafeEqualBase64Url(digest, challenge)))
      : Effect.succeed(false);

  const redeem: EnvironmentJoin["Service"]["redeem"] = Effect.fn("EnvironmentJoin.redeem")(
    function* (input) {
      const key = yield* sha256(input.code);
      // A presented code is spent even when a later check fails (RFC 6749 §4.1.2).
      const pending = yield* Ref.modify(codes, (current) => {
        const found = current.get(key);
        if (found === undefined) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(key);
        return [found, next] as const;
      });
      const now = yield* Clock.currentTimeMillis;
      if (
        pending === undefined ||
        pending.expiresAtMs <= now ||
        pending.redirectUri !== input.redirectUri ||
        !(yield* pkceVerifies(input.codeVerifier, pending.codeChallenge))
      ) {
        return yield* new EnvironmentJoinInvalidGrantError({});
      }
      const registered = yield* registry.register({
        approvedBy: pending.approvedBy,
        name: pending.name,
        os: pending.os,
        hostname: pending.hostname,
      });
      return {
        environmentId: registered.environmentId,
        hubEnvironmentId: registry.hubId as EnvironmentId,
        name: pending.name,
        credential: registered.credential,
      };
    },
  );

  return EnvironmentJoin.of({ approve, redeem });
});

export const layer = Layer.effect(EnvironmentJoin, make);
