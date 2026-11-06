// The desktop and mobile apps sign a User in to a Hub through the system browser. Each app opens
// the Hub's `/app-sign-in` page with a PKCE challenge, receives a one-time code on its callback
// (a loopback port on desktop, the app's URL scheme on mobile), and exchanges it here. The
// verifier never leaves the app, and the session it gets belongs to the User who signed in.
import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import { normalizeHttpBaseUrl } from "@t3tools/shared/advertisedEndpoint";
import {
  type AppSignInCallback,
  appSignInPageUrl,
  readAppSignInCallback,
} from "@t3tools/shared/appSignIn";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const base64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
};

/** The Hub's address as typed: `hub.example.com` means `https://hub.example.com/`. */
export function normalizeHubUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") throw new Error("Enter the Hub's address.");
  return normalizeHttpBaseUrl(
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`,
  );
}

/** One sign-in attempt: what the app keeps (verifier, state) and what the page gets. */
export interface AppSignInAttempt {
  readonly hubUrl: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly state: string;
}

export const startAppSignIn = Effect.fn("clientRuntime.appSignIn.start")(function* (
  hubUrl: string,
) {
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const codeVerifier = base64Url(yield* random.randomBytes(32));
  const state = base64Url(yield* random.randomBytes(16));
  const codeChallenge = base64Url(
    yield* digest.digest(Digest.sha256, new TextEncoder().encode(codeVerifier)),
  );
  return { hubUrl, codeVerifier, codeChallenge, state } satisfies AppSignInAttempt;
});

/** The page to open in the system browser for this attempt and callback. */
export const appSignInPageFor = (
  attempt: AppSignInAttempt,
  redirectUri: string,
  clientLabel?: string,
) =>
  appSignInPageUrl(attempt.hubUrl, {
    redirectUri,
    codeChallenge: attempt.codeChallenge,
    state: attempt.state,
    ...(clientLabel ? { clientLabel } : {}),
  });

/** Reads the callback the app received; one not carrying this attempt's state is refused. */
export const readAppSignInCallbackFor = (
  attempt: AppSignInAttempt,
  redirectUri: string,
  callbackUrl: string,
): AppSignInCallback => readAppSignInCallback(callbackUrl, { redirectUri, state: attempt.state });

export const exchangeAppSignInCode = Effect.fn("clientRuntime.appSignIn.exchange")(
  function* (input: {
    readonly hubUrl: string;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly clientMetadata?: AuthClientPresentationMetadata;
  }) {
    const client = yield* makeEnvironmentHttpApiGroupClient(input.hubUrl, "appSignIn");
    const os = input.clientMetadata?.os;
    return yield* executeEnvironmentHttpRequest(
      environmentEndpointUrl(input.hubUrl, "/api/auth/app-sign-in/token"),
      DEFAULT_REQUEST_TIMEOUT_MS,
      client.token({
        headers: {},
        payload: {
          grant_type: "authorization_code",
          code: input.code,
          code_verifier: input.codeVerifier,
          redirect_uri: input.redirectUri,
          ...(input.clientMetadata?.label ? { client_label: input.clientMetadata.label } : {}),
          ...(input.clientMetadata?.deviceType
            ? { client_device_type: input.clientMetadata.deviceType }
            : {}),
          ...(os && os !== "unknown" && os !== "other" ? { client_os: os } : {}),
        },
      }),
    );
  },
);

/** Ends this app's session on the Hub, so removing a Hub from the app also signs it out there. */
export const signOutRemoteSession = Effect.fn("clientRuntime.appSignIn.signOut")(function* (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "auth");
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/api/auth/sign-out"),
    input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    client.signOut({ headers: { authorization: `Bearer ${input.bearerToken}` } }),
  );
});
