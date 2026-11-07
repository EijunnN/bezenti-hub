import type {
  EnvironmentId,
  SandboxImageStatus,
  UpdateSandboxImageResult,
} from "@t3tools/contracts";

import { request } from "./userAccounts";

/**
 * The Sandbox base image, its last build and each Sandbox's version: the Owner's. With `after`
 * (the `logLines` already shown), only the build's newer lines come back.
 */
export function fetchSandboxImageStatus(after?: number): Promise<SandboxImageStatus> {
  return request((client) =>
    client.sandboxImage.status({ headers: {}, query: after === undefined ? {} : { after } }),
  );
}

/** Starts a build on the Hub and answers at once; follow it with {@link fetchSandboxImageStatus}. */
export function buildSandboxImage(): Promise<SandboxImageStatus> {
  return request((client) => client.sandboxImage.build({ headers: {} }));
}

/** Moves a running Sandbox to the newest image; refused, saying why, while a turn runs on it. */
export function updateSandboxImage(
  environmentId: EnvironmentId,
): Promise<UpdateSandboxImageResult> {
  return request((client) =>
    client.sandboxImage.update({ headers: {}, payload: { environmentId } }),
  );
}
