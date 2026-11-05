import * as Schema from "effect/Schema";

import { AuthBrowserSessionResult } from "./auth.ts";
import { TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";

export const AuthUser = Schema.Struct({
  id: UserId,
  displayName: TrimmedNonEmptyString,
  isOwner: Schema.Boolean,
});
export type AuthUser = typeof AuthUser.Type;

export const AuthOwnerBootstrapStatusRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
});
export type AuthOwnerBootstrapStatusRequest = typeof AuthOwnerBootstrapStatusRequest.Type;

/**
 * `available`: the credential is the administrative bootstrap link and no Owner exists yet.
 * `claimed`: the credential is the administrative bootstrap link but the Owner already exists.
 * `not-applicable`: any other credential, which pairs as before.
 */
export const AuthOwnerBootstrapStatus = Schema.Struct({
  status: Schema.Literals(["available", "claimed", "not-applicable"]),
});
export type AuthOwnerBootstrapStatus = typeof AuthOwnerBootstrapStatus.Type;

// The subset of the WebAuthn JSON options this server emits, shaped for `@simplewebauthn/browser`.
export const AuthPasskeyCreationOptions = Schema.Struct({
  challenge: TrimmedNonEmptyString,
  rp: Schema.Struct({ id: TrimmedNonEmptyString, name: TrimmedNonEmptyString }),
  user: Schema.Struct({
    id: TrimmedNonEmptyString,
    name: TrimmedNonEmptyString,
    displayName: TrimmedNonEmptyString,
  }),
  pubKeyCredParams: Schema.Array(
    Schema.Struct({ alg: Schema.Number, type: Schema.Literal("public-key") }),
  ),
  timeout: Schema.Number,
  authenticatorSelection: Schema.Struct({
    residentKey: Schema.Literal("required"),
    requireResidentKey: Schema.Literal(true),
    userVerification: Schema.Literal("preferred"),
  }),
  attestation: Schema.Literal("none"),
});
export type AuthPasskeyCreationOptions = typeof AuthPasskeyCreationOptions.Type;

export const AuthPasskeyRequestOptions = Schema.Struct({
  challenge: TrimmedNonEmptyString,
  rpId: TrimmedNonEmptyString,
  timeout: Schema.Number,
  userVerification: Schema.Literal("preferred"),
});
export type AuthPasskeyRequestOptions = typeof AuthPasskeyRequestOptions.Type;

export const AuthPasskeyRegistrationCeremony = Schema.Struct({
  ceremonyId: TrimmedNonEmptyString,
  options: AuthPasskeyCreationOptions,
});
export type AuthPasskeyRegistrationCeremony = typeof AuthPasskeyRegistrationCeremony.Type;

export const AuthPasskeySignInCeremony = Schema.Struct({
  ceremonyId: TrimmedNonEmptyString,
  options: AuthPasskeyRequestOptions,
});
export type AuthPasskeySignInCeremony = typeof AuthPasskeySignInCeremony.Type;

export const AuthPasskeyRegistrationResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  rawId: TrimmedNonEmptyString,
  type: Schema.Literal("public-key"),
  response: Schema.Struct({
    clientDataJSON: TrimmedNonEmptyString,
    attestationObject: TrimmedNonEmptyString,
    transports: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
});
export type AuthPasskeyRegistrationResponse = typeof AuthPasskeyRegistrationResponse.Type;

export const AuthPasskeyAuthenticationResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  rawId: TrimmedNonEmptyString,
  type: Schema.Literal("public-key"),
  response: Schema.Struct({
    clientDataJSON: TrimmedNonEmptyString,
    authenticatorData: TrimmedNonEmptyString,
    signature: TrimmedNonEmptyString,
    userHandle: Schema.optionalKey(Schema.String),
  }),
});
export type AuthPasskeyAuthenticationResponse = typeof AuthPasskeyAuthenticationResponse.Type;

export const AuthOwnerRegistrationRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});
export type AuthOwnerRegistrationRequest = typeof AuthOwnerRegistrationRequest.Type;

export const AuthOwnerBootstrapRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
  ceremonyId: TrimmedNonEmptyString,
  response: AuthPasskeyRegistrationResponse,
});
export type AuthOwnerBootstrapRequest = typeof AuthOwnerBootstrapRequest.Type;

export const AuthOwnerBootstrapResult = Schema.Struct({
  session: AuthBrowserSessionResult,
  user: AuthUser,
  /** Shown once; the server keeps only their hashes. */
  recoveryCodes: Schema.Array(TrimmedNonEmptyString),
});
export type AuthOwnerBootstrapResult = typeof AuthOwnerBootstrapResult.Type;

export const AuthPasskeySignInRequest = Schema.Struct({
  ceremonyId: TrimmedNonEmptyString,
  response: AuthPasskeyAuthenticationResponse,
});
export type AuthPasskeySignInRequest = typeof AuthPasskeySignInRequest.Type;

export const AuthRecoveryCodeSignInRequest = Schema.Struct({
  code: TrimmedNonEmptyString,
});
export type AuthRecoveryCodeSignInRequest = typeof AuthRecoveryCodeSignInRequest.Type;

export const AuthSignOutResult = Schema.Struct({
  signedOut: Schema.Boolean,
});
export type AuthSignOutResult = typeof AuthSignOutResult.Type;
