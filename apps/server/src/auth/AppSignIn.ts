import type {
  AuthAccessTokenResult,
  AuthAppSignInApproveRequest,
  AuthAppSignInTokenRequest,
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

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { base64UrlEncode, timingSafeEqualBase64Url, type AuthRequestMetadata } from "./utils.ts";

// Desktop and mobile sign-in through the system browser (RFC 8252): a browser session approves a
// one-time code bound to the app's PKCE challenge and redirect; the app exchanges it with its
// verifier for a session of that User. See docs/internals/environment-auth.md#app-sign-in.

/** Long enough for the browser to hand the code back, short enough that a leaked one is stale. */
const APP_SIGN_IN_CODE_TTL_MS = 60_000;

interface PendingCode {
  readonly userId: UserId;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly clientLabel: string | undefined;
  readonly expiresAtMs: number;
}

export class AppSignInRequestError extends Schema.TaggedError<AppSignInRequestError>()(
  "AppSignInRequestError",
  { reason: Schema.Literals(["invalid_redirect_uri", "invalid_code_challenge"]) },
) {}

/** The approving request carried no browser session of a User. */
export class AppSignInNotSignedInError extends Schema.TaggedError<AppSignInNotSignedInError>()(
  "AppSignInNotSignedInError",
  {},
) {
  override get message(): string {
    return "Sign in to this Hub in the browser first.";
  }
}

/** Unknown, used, expired, or presented with the wrong verifier or redirect: all look alike. */
export class AppSignInInvalidGrantError extends Schema.TaggedError<AppSignInInvalidGrantError>()(
  "AppSignInInvalidGrantError",
  {},
) {
  override get message(): string {
    return "The sign-in code is invalid or expired. Sign in again.";
  }
}

export class AppSignIn extends Context.Service<
  AppSignIn,
  {
    /** Approves with the request's browser session and answers the redirect back to the app. */
    readonly approve: (
      request: HttpServerRequest.HttpServerRequest,
      input: AuthAppSignInApproveRequest,
    ) => Effect.Effect<
      string,
      AppSignInRequestError | AppSignInNotSignedInError | EnvironmentAuth.ServerAuthInternalError
    >;
    readonly exchange: (input: {
      readonly token: AuthAppSignInTokenRequest;
      /** The requesting client, with the label, device type and OS the app presented. */
      readonly client: AuthRequestMetadata;
      readonly proofKeyThumbprint?: string;
    }) => Effect.Effect<
      AuthAccessTokenResult,
      | AppSignInInvalidGrantError
      | EnvironmentAuth.ServerAuthInvalidCredentialError
      | EnvironmentAuth.ServerAuthInsecureTransportError
      | EnvironmentAuth.ServerAuthInternalError
    >;
  }
>()("t3/auth/AppSignIn") {}

const make = Effect.gen(function* () {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  // Keyed by the code's SHA-256, so the codes themselves are never held.
  const codes = yield* Ref.make<ReadonlyMap<string, PendingCode>>(new Map());

  const sha256 = (value: string) =>
    digester.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(
      Effect.orDie,
      Effect.map((digest) => base64UrlEncode(digest)),
    );

  const approve: AppSignIn["Service"]["approve"] = Effect.fn("AppSignIn.approve")(
    function* (request, input) {
      if (appSignInRedirectKind(input.redirectUri) === null) {
        return yield* new AppSignInRequestError({ reason: "invalid_redirect_uri" });
      }
      if (!isAppSignInCodeChallenge(input.codeChallenge) || !isAppSignInState(input.state)) {
        return yield* new AppSignInRequestError({ reason: "invalid_code_challenge" });
      }
      // Only the browser's own cookie approves (its origin is checked with it), never a token an
      // app already holds, so every app session traces back to a sign-in in a browser.
      const session = yield* environmentAuth
        .authenticateBrowserSession(request)
        .pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
            Effect.fail(new AppSignInNotSignedInError({})),
          ),
        );
      if (session.userId === undefined) return yield* new AppSignInNotSignedInError({});
      const now = yield* Clock.currentTimeMillis;
      const code = Buffer.from(yield* random.randomBytes(32)).toString("base64url");
      const key = yield* sha256(code);
      const pending: PendingCode = {
        userId: session.userId,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        clientLabel: input.clientLabel?.slice(0, 80),
        expiresAtMs: now + APP_SIGN_IN_CODE_TTL_MS,
      };
      yield* Ref.update(codes, (current) => {
        const next = new Map(
          Array.from(current).filter(([, existing]) => existing.expiresAtMs > now),
        );
        next.set(key, pending);
        return next;
      });
      yield* Effect.logInfo("Approved an app sign-in.", {
        redirect: appSignInRedirectKind(input.redirectUri),
      });
      return appSignInCallbackUrl(input.redirectUri, code, input.state);
    },
  );

  const pkceVerifies = (verifier: string, challenge: string) =>
    isAppSignInCodeVerifier(verifier)
      ? sha256(verifier).pipe(Effect.map((digest) => timingSafeEqualBase64Url(digest, challenge)))
      : Effect.succeed(false);

  const exchange: AppSignIn["Service"]["exchange"] = Effect.fn("AppSignIn.exchange")(function* ({
    token,
    client,
    proofKeyThumbprint,
  }) {
    const key = yield* sha256(token.code);
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
      pending.redirectUri !== token.redirect_uri ||
      !(yield* pkceVerifies(token.code_verifier, pending.codeChallenge))
    ) {
      return yield* new AppSignInInvalidGrantError({});
    }
    const label = client.label ?? pending.clientLabel;
    return yield* environmentAuth.issueAppSession({
      userId: pending.userId,
      client: label === undefined ? client : { ...client, label },
      ...(proofKeyThumbprint === undefined ? {} : { proofKeyThumbprint }),
    });
  });

  return AppSignIn.of({ approve, exchange });
});

export const layer = Layer.effect(AppSignIn, make);
