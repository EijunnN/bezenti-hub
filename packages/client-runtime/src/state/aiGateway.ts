import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** The Hub's AI gateway (Settings → AI gateway, the Owner's) and its AI accounts. */
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
    // AI accounts (spec 4): everyone lists what they may use; the Owner changes them. No answer
    // carries a credential.
    listAccounts: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:list",
      tag: WS_METHODS.aiAccountsList,
    }),
    createAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:create",
      tag: WS_METHODS.aiAccountsCreate,
    }),
    updateAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:update",
      tag: WS_METHODS.aiAccountsUpdate,
    }),
    deleteAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:delete",
      tag: WS_METHODS.aiAccountsDelete,
    }),
    allowAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:allow",
      tag: WS_METHODS.aiAccountsAllow,
    }),
    reorderAccounts: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:ai-accounts:reorder",
      tag: WS_METHODS.aiAccountsReorder,
    }),
  };
}
