import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { hubEnvironmentIdAtom } from "./primaryEnvironment";

/** The Hub connection's id, which every Thread route resolves against. */
export function useHubEnvironmentId(): EnvironmentId | null {
  return useAtomValue(hubEnvironmentIdAtom);
}

/** The Hub connection's id now, which every Thread route resolves against. */
export function readHubEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(hubEnvironmentIdAtom);
}
