import {
  type AuthOwnerBootstrapResult,
  type AuthOwnerBootstrapStatus,
  EnvironmentHttpCommonError,
  EnvironmentHttpConflictError,
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

function toUserSignInError(cause: unknown, rejectedMessage: string): UserSignInError {
  if (isUserSignInError(cause)) return cause;
  if (isEnvironmentHttpConflictError(cause)) {
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
  const registration = await startRegistration({
    optionsJSON: {
      ...ceremony.options,
      pubKeyCredParams: [...ceremony.options.pubKeyCredParams],
    },
  }).catch((cause: unknown) => {
    throw toUserSignInError(cause, "");
  });
  return request(
    (client) =>
      client.auth.ownerBootstrap({
        payload: {
          credential: input.credential,
          ceremonyId: ceremony.ceremonyId,
          response: {
            id: registration.id,
            rawId: registration.rawId,
            type: "public-key",
            response: {
              clientDataJSON: registration.response.clientDataJSON,
              attestationObject: registration.response.attestationObject,
              ...(registration.response.transports
                ? { transports: registration.response.transports }
                : {}),
            },
          },
        },
      }),
    "This setup link expired or the passkey was not accepted. Restart the server for a new link.",
  );
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
