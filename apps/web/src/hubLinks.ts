import type { EnvironmentId } from "@t3tools/contracts";
import { addHubOrigin, hubLinkOrigin } from "@t3tools/shared/threadLinks";

import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./state/server";
import { readPrimaryEnvironmentId } from "./state/environments";
import { readPreparedConnection } from "./state/session";

function windowOrigin(): string | null {
  return typeof window === "undefined" || window.location === undefined
    ? null
    : window.location.origin;
}

/** The Hub serves this web app, so links to the page's own origin are links to its threads. */
export function registerWindowHubOrigin(): void {
  addHubOrigin(windowOrigin());
}

/**
 * Where copied links to `environmentId` (else the primary environment) point: its Hub's public
 * URL, else the address this client reaches it on, else this page's origin. Null in a desktop
 * window with no http address for the Hub.
 */
export function readHubLinkOrigin(environmentId?: EnvironmentId | null): string | null {
  const target = environmentId ?? readPrimaryEnvironmentId();
  const config =
    target === null ? undefined : appAtomRegistry.get(environmentServerConfigsAtom).get(target);
  const connection = target === null ? null : readPreparedConnection(target);
  return hubLinkOrigin({
    publicUrl: config?.environment.publicUrl,
    currentOrigin: connection?.httpBaseUrl ?? windowOrigin(),
  });
}
