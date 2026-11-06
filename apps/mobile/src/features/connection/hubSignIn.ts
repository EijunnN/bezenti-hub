import {
  appSignInPageFor,
  normalizeHubUrl,
  readAppSignInCallbackFor,
  startAppSignIn,
} from "@t3tools/client-runtime/authorization";
import {
  APP_SIGN_IN_SCHEMES,
  type AppSignInScheme,
  appSignInMobileRedirectUri,
} from "@t3tools/shared/appSignIn";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as WebBrowser from "expo-web-browser";
import * as Effect from "effect/Effect";

import * as Crypto from "../../lib/crypto";

export type HubSignInOutcome =
  | {
      readonly _tag: "code";
      readonly hubUrl: string;
      readonly code: string;
      readonly codeVerifier: string;
      readonly redirectUri: string;
    }
  | { readonly _tag: "cancelled" };

function appScheme(): AppSignInScheme {
  const configured = Constants.expoConfig?.scheme;
  const scheme = Array.isArray(configured) ? configured[0] : configured;
  return APP_SIGN_IN_SCHEMES.find((candidate) => candidate === scheme) ?? "t3code";
}

/**
 * Opens the Hub's sign-in page in an in-app browser session (ASWebAuthenticationSession on iOS,
 * Custom Tabs on Android) and returns the one-time code it hands back to this app's scheme. The
 * PKCE verifier stays here; a callback without this attempt's state is refused.
 */
export async function signInToHubInBrowser(hubAddress: string): Promise<HubSignInOutcome> {
  const hubUrl = normalizeHubUrl(hubAddress);
  const attempt = await Effect.runPromise(
    startAppSignIn(hubUrl).pipe(Effect.provide(Crypto.layer)),
  );
  const redirectUri = appSignInMobileRedirectUri(appScheme());
  const result = await WebBrowser.openAuthSessionAsync(
    appSignInPageFor(attempt, redirectUri, Device.deviceName ?? "T3 Code mobile"),
    redirectUri,
  );
  if (result.type !== "success") return { _tag: "cancelled" };
  const callback = readAppSignInCallbackFor(attempt, redirectUri, result.url);
  if (callback._tag === "cancelled") return { _tag: "cancelled" };
  if (callback._tag === "invalid") {
    throw new Error("The Hub's answer did not match this sign-in. Try again.");
  }
  return {
    _tag: "code",
    hubUrl,
    code: callback.code,
    codeVerifier: attempt.codeVerifier,
    redirectUri,
  };
}
