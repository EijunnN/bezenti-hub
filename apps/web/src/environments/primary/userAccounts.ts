import {
  type AuthAccount,
  type AuthOwnerBootstrapResult,
  type AuthOwnerBootstrapStatus,
  type AuthPasskeyRegistrationCeremony,
  type AuthResetLinkStatus,
  type AuthSetPasswordRequest,
  type AuthTotpEnrollment,
  EnvironmentHttpCommonError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
} from "@t3tools/contracts";
import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { runPrimaryHttp } from "../../lib/runtime";
import { PrimaryEnvironmentHttpClient } from "./httpClient";

export class UserSignInError extends Schema.TaggedError<UserSignInError>()("UserSignInError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const isUserSignInError = Schema.is(UserSignInError);
const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const isEnvironmentHttpConflictError = Schema.is(EnvironmentHttpConflictError);
const isEnvironmentHttpForbiddenError = Schema.is(EnvironmentHttpForbiddenError);

function toUserSignInError(cause: unknown, rejectedMessage: string): UserSignInError {
  if (isUserSignInError(cause)) return cause;
  if (isEnvironmentHttpConflictError(cause) || isEnvironmentHttpForbiddenError(cause)) {
    return new UserSignInError({ message: cause.message, cause });
  }
  if (isEnvironmentHttpCommonError(cause)) {
    if (cause._tag === "EnvironmentAuthInvalidError") {
      return new UserSignInError({ message: rejectedMessage, cause });
    }
    if (cause._tag === "EnvironmentRequestInvalidError" && cause.reason === "invalid_origin") {
      return new UserSignInError({
        message: "Open this page from the Installation's own address to use a passkey.",
        cause,
      });
    }
  }
  if (
    cause instanceof WebAuthnError ||
    (cause instanceof Error && cause.name === "NotAllowedError")
  ) {
    return new UserSignInError({ message: "The passkey request was cancelled.", cause });
  }
  return new UserSignInError({ message: "Could not reach this Installation. Try again.", cause });
}

async function request<A, E>(
  run: (client: Context.Service.Shape<typeof PrimaryEnvironmentHttpClient>) => Effect.Effect<A, E>,
  rejectedMessage = "That sign-in was not accepted.",
): Promise<A> {
  try {
    return await runPrimaryHttp(PrimaryEnvironmentHttpClient.pipe(Effect.flatMap(run)));
  } catch (cause) {
    throw toUserSignInError(cause, rejectedMessage);
  }
}

export function fetchOwnerBootstrapStatus(
  credential: string,
): Promise<AuthOwnerBootstrapStatus["status"]> {
  return request((client) => client.auth.ownerBootstrapStatus({ payload: { credential } })).then(
    (result) => result.status,
  );
}

/** Registers the Owner's passkey and signs this browser in; the codes are shown once. */
export async function createOwnerAccount(input: {
  readonly credential: string;
  readonly displayName: string;
}): Promise<AuthOwnerBootstrapResult> {
  const ceremony = await request((client) => client.auth.ownerRegistration({ payload: input }));
  const response = await registerPasskey(ceremony);
  return request(
    (client) =>
      client.auth.ownerBootstrap({
        payload: { credential: input.credential, ceremonyId: ceremony.ceremonyId, response },
      }),
    "This setup link expired or the passkey was not accepted. Restart the server for a new link.",
  );
}

async function registerPasskey(ceremony: AuthPasskeyRegistrationCeremony) {
  const registration = await startRegistration({
    optionsJSON: {
      ...ceremony.options,
      pubKeyCredParams: [...ceremony.options.pubKeyCredParams],
    },
  }).catch((cause: unknown) => {
    throw toUserSignInError(cause, "");
  });
  return {
    id: registration.id,
    rawId: registration.rawId,
    type: "public-key" as const,
    response: {
      clientDataJSON: registration.response.clientDataJSON,
      attestationObject: registration.response.attestationObject,
      ...(registration.response.transports ? { transports: registration.response.transports } : {}),
    },
  };
}

export async function fetchResetLinkStatus(token: string): Promise<AuthResetLinkStatus> {
  return request((client) => client.auth.resetLinkStatus({ payload: { token } }));
}

/** Registers a new passkey from a reset link, which is then spent, and signs this browser in. */
export async function resetPasskey(token: string): Promise<void> {
  const rejected = "This reset link expired or was already used. Issue a new one from the Hub.";
  const ceremony = await request(
    (client) => client.auth.resetLinkRegistration({ payload: { token } }),
    rejected,
  );
  const response = await registerPasskey(ceremony);
  await request(
    (client) =>
      client.auth.redeemResetLink({
        payload: { token, ceremonyId: ceremony.ceremonyId, response },
      }),
    rejected,
  );
}

/** "totp-required" when the password was right but the account also needs a code. */
export async function signInWithPassword(input: {
  readonly loginName: string;
  readonly password: string;
  readonly totpCode?: string;
}): Promise<"signed-in" | "totp-required"> {
  const result = await request(
    (client) => client.auth.passwordSignIn({ payload: input }),
    input.totpCode === undefined
      ? "That sign-in name or password is not right."
      : "That code is not right, or it was already used. Wait for the next one.",
  );
  return result.authenticated ? "signed-in" : "totp-required";
}

export function fetchAccount(): Promise<AuthAccount> {
  return request((client) => client.auth.account({ headers: {} }));
}

export function setAccountPassword(payload: AuthSetPasswordRequest): Promise<AuthAccount> {
  return request((client) => client.auth.setPassword({ headers: {}, payload }));
}

export function startTotpEnrollment(): Promise<AuthTotpEnrollment> {
  return request((client) => client.auth.startTotpEnrollment({ headers: {} }));
}

export function confirmTotpEnrollment(code: string): Promise<AuthAccount> {
  return request((client) => client.auth.confirmTotpEnrollment({ headers: {}, payload: { code } }));
}

export async function signInWithPasskey(): Promise<void> {
  const ceremony = await request((client) => client.auth.passkeyChallenge({}));
  const assertion = await startAuthentication({ optionsJSON: ceremony.options }).catch(
    (cause: unknown) => {
      throw toUserSignInError(cause, "");
    },
  );
  await request(
    (client) =>
      client.auth.passkeySignIn({
        payload: {
          ceremonyId: ceremony.ceremonyId,
          response: {
            id: assertion.id,
            rawId: assertion.rawId,
            type: "public-key",
            response: {
              clientDataJSON: assertion.response.clientDataJSON,
              authenticatorData: assertion.response.authenticatorData,
              signature: assertion.response.signature,
              ...(assertion.response.userHandle !== undefined
                ? { userHandle: assertion.response.userHandle }
                : {}),
            },
          },
        },
      }),
    "That passkey is not registered on this Installation.",
  );
}

export async function signInWithRecoveryCode(code: string): Promise<void> {
  await request(
    (client) => client.auth.recoveryCodeSignIn({ payload: { code } }),
    "That recovery code is unknown or was already used.",
  );
}

export async function signOut(): Promise<void> {
  await request((client) => client.auth.signOut({}));
}
