import type { EnvironmentId } from "@t3tools/contracts";
import { hubLinkOrigin } from "@t3tools/shared/threadLinks";
import * as Option from "effect/Option";

import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { environmentSession } from "./session";

/**
 * Where copied links to `environmentId` point: its Hub's public URL, else the address this phone
 * reaches it on. Null when neither is known, and the copy falls back to a `t3-thread://` link.
 */
export function readHubLinkOrigin(environmentId: EnvironmentId): string | null {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  const connection = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  return hubLinkOrigin({
    publicUrl: config?.environment.publicUrl,
    currentOrigin: connection?.httpBaseUrl,
  });
}
