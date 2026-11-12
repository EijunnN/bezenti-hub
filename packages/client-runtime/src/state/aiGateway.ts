import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** The Hub's AI gateway (Settings → AI gateway): its Owner's alone. */
export function createAiGatewayEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // Streamed: a crash and its restart show at once.
    status: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:ai-gateway:status",
      tag: WS_METHODS.aiGatewayStatus,
      idleTtlMs: 0,
    }),
    // Fetched while the section is open and again on request; dropped when it closes.
    checkForUpdates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:ai-gateway:check-for-updates",
      tag: WS_METHODS.aiGatewayCheckForUpdates,
      idleTtlMs: 0,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-gateway:update",
      tag: WS_METHODS.aiGatewayUpdate,
    }),
    rollback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-gateway:rollback",
      tag: WS_METHODS.aiGatewayRollback,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-gateway:set-enabled",
      tag: WS_METHODS.aiGatewaySetEnabled,
    }),
  };
}
