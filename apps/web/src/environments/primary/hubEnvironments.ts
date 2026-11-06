import type { EnvironmentId, HubEnvironmentList, HubEnvironmentSummary } from "@t3tools/contracts";
import type { EnvironmentJoinPageRequest } from "@t3tools/shared/environmentJoin";

import { request, type StepUp, toReauth, UserSignInError } from "./userAccounts";

/** The machines this Hub knows, as the signed-in User may see them. */
export function fetchHubEnvironments(): Promise<HubEnvironmentList> {
  return request((client) => client.environments.list({ headers: {} }));
}

export function renameHubEnvironment(
  environmentId: EnvironmentId,
  name: string,
): Promise<HubEnvironmentSummary> {
  return request((client) =>
    client.environments.rename({ headers: {}, payload: { environmentId, name } }),
  );
}

export function removeHubEnvironment(environmentId: EnvironmentId): Promise<HubEnvironmentList> {
  return request((client) =>
    client.environments.remove({ headers: {}, payload: { environmentId } }),
  );
}

const STRONG_FACTOR_REQUIRED =
  "Confirm with your passkey, or with your password and a code from your app.";

/** The Owner's approval of `t3 join`, with a strong factor; answers where to send the browser. */
export async function approveEnvironmentJoin(input: {
  readonly request: EnvironmentJoinPageRequest;
  readonly name: string;
  readonly stepUp: StepUp;
}): Promise<string> {
  const reauth = await toReauth(input.stepUp);
  if (reauth === undefined) throw new UserSignInError({ message: STRONG_FACTOR_REQUIRED });
  const result = await request(
    (client) =>
      client.environments.approveJoin({
        payload: {
          redirectUri: input.request.redirectUri,
          codeChallenge: input.request.codeChallenge,
          codeChallengeMethod: "S256",
          state: input.request.state,
          name: input.name,
          os: input.request.os,
          hostname: input.request.hostname,
          reauth,
        },
      }),
    "Sign in to this Hub again, then approve the machine.",
  );
  return result.redirectTo;
}
