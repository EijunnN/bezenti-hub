import { readAppSignInPageRequest } from "@t3tools/shared/appSignIn";
import { expect, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  appSignInPageFor,
  normalizeHubUrl,
  readAppSignInCallbackFor,
  startAppSignIn,
} from "./appSignIn.ts";

const crypto = Layer.merge(SecureRandom.layerWebCrypto, Digest.layerWebCrypto);
const LOOPBACK = "http://127.0.0.1:53111/callback";

it.effect("asks the Hub's page for a code bound to an S256 challenge of a fresh verifier", () =>
  Effect.gen(function* () {
    const attempt = yield* startAppSignIn("https://hub.example.com/");
    const other = yield* startAppSignIn("https://hub.example.com/");
    expect(attempt.codeVerifier).not.toBe(other.codeVerifier);
    expect(attempt.state).not.toBe(other.state);
    const digest = yield* Effect.promise(() =>
      globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(attempt.codeVerifier)),
    );
    expect(attempt.codeChallenge).toBe(Buffer.from(digest).toString("base64url"));
    const page = appSignInPageFor(attempt, LOOPBACK, "T3 Code desktop");
    expect(page.startsWith("https://hub.example.com/app-sign-in?")).toBe(true);
    // The page reads back exactly what the app sent, and never the verifier.
    expect(readAppSignInPageRequest(page)).toEqual({
      redirectUri: LOOPBACK,
      codeChallenge: attempt.codeChallenge,
      state: attempt.state,
      clientLabel: "T3 Code desktop",
    });
    expect(page).not.toContain(attempt.codeVerifier);
  }).pipe(Effect.provide(crypto)),
);

it.effect("takes a code only from a callback carrying this attempt's state", () =>
  Effect.gen(function* () {
    const attempt = yield* startAppSignIn("https://hub.example.com/");
    const read = (url: string) => readAppSignInCallbackFor(attempt, LOOPBACK, url);
    expect(read(`${LOOPBACK}?code=abc&state=${attempt.state}`)).toEqual({
      _tag: "code",
      code: "abc",
    });
    expect(read(`${LOOPBACK}?code=abc&state=someone-elses`)).toEqual({ _tag: "invalid" });
    expect(read(`http://127.0.0.1:1/callback?code=abc&state=${attempt.state}`)).toEqual({
      _tag: "invalid",
    });
    expect(read(`${LOOPBACK}?error=access_denied&state=${attempt.state}`)).toEqual({
      _tag: "cancelled",
    });
    const mobile = "t3code://auth/callback";
    expect(
      readAppSignInCallbackFor(attempt, mobile, `${mobile}?code=xyz&state=${attempt.state}`),
    ).toEqual({ _tag: "code", code: "xyz" });
  }).pipe(Effect.provide(crypto)),
);

it("reads a typed Hub address as HTTPS unless it names a scheme", () => {
  expect(normalizeHubUrl(" hub.example.com ")).toBe("https://hub.example.com/");
  expect(normalizeHubUrl("http://192.168.1.20:3773/sign-in")).toBe("http://192.168.1.20:3773/");
  expect(() => normalizeHubUrl("")).toThrow();
});
