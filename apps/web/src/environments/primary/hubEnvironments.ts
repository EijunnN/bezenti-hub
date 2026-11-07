import type {
  EnvironmentId,
  EnvironmentJoinRequestView,
  HubEnvironmentList,
  HubEnvironmentSummary,
  SpaceId,
} from "@t3tools/contracts";

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

/**
 * The Owner makes a machine personal (their own) or dedicates it to an Organization. Refused while
 * Threads are on it; the refusal names them.
 */
export function changeHubEnvironmentMode(
  environmentId: EnvironmentId,
  target: { readonly mode: "personal" } | { readonly mode: "dedicated"; readonly spaceId: SpaceId },
): Promise<HubEnvironmentSummary> {
  return request((client) =>
    client.environments.changeMode({ headers: {}, payload: { environmentId, ...target } }),
  );
}

/** «Try again» on a Sandbox that failed to start: answers at once, with it starting. */
export function startHubEnvironment(environmentId: EnvironmentId): Promise<HubEnvironmentSummary> {
  return request((client) =>
    client.environments.start({ headers: {}, payload: { environmentId } }),
  );
}

/** The `t3 join` request a «Register this machine» link names. */
export function fetchEnvironmentJoinRequest(
  requestId: string,
): Promise<EnvironmentJoinRequestView> {
  return request(
    (client) => client.environments.joinRequest({ payload: { requestId } }),
    "This registration expired or was already decided. Run `t3 join` again.",
  );
}

const STRONG_FACTOR_REQUIRED =
  "Confirm with your passkey, or with your password and a code from your app.";

/** The Owner's approval, with a strong factor; answers where to send the browser, if anywhere. */
export async function approveEnvironmentJoin(input: {
  readonly requestId: string;
  readonly name: string;
  readonly stepUp: StepUp;
  /** Dedicates it to this Organization instead (the Owner only). */
  readonly dedicatedSpaceId?: SpaceId | undefined;
}): Promise<string | null> {
  const reauth = await toReauth(input.stepUp);
  if (reauth === undefined) throw new UserSignInError({ message: STRONG_FACTOR_REQUIRED });
  const result = await request(
    (client) =>
      client.environments.approveJoin({
        payload: {
          requestId: input.requestId,
          name: input.name,
          reauth,
          ...(input.dedicatedSpaceId === undefined
            ? {}
            : { dedicatedSpaceId: input.dedicatedSpaceId }),
        },
      }),
    "Sign in to this Hub again, then approve the machine.",
  );
  return result.redirectTo;
}

export async function denyEnvironmentJoin(requestId: string): Promise<string | null> {
  const result = await request((client) =>
    client.environments.denyJoin({ payload: { requestId } }),
  );
  return result.redirectTo;
}
