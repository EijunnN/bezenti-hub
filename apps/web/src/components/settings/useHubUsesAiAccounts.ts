import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { aiGatewayEnvironment } from "../../state/aiGateway";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Spec 4 ticket 07: whether the Hub runs its turns on AI accounts (one is set up and enabled), so
 * its providers' account sign-ins (Antigravity's Google account) are not offered. The Hub decides
 * and refuses on its own; this only explains it in the form. Unreadable: false (nothing disabled).
 */
export function useHubUsesAiAccounts(environmentId: EnvironmentId | undefined): boolean {
  const list = useAtomCommand(aiGatewayEnvironment.listAccounts, "list the AI accounts");
  const [uses, setUses] = useState(false);
  const load = useEffectEvent((target: EnvironmentId) =>
    list({ environmentId: target, input: {} }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads from the Hub, once per environment, whether it has an enabled AI account, to explain disabled sign-in methods.
  useEffect(() => {
    if (environmentId === undefined) return;
    let cancelled = false;
    void load(environmentId).then((result) => {
      if (cancelled || result._tag !== "Success") return;
      setUses(result.value.accounts.some((account) => !account.disabled));
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);
  return uses;
}

/** Antigravity's account sign-ins, never offered once the Hub runs on AI accounts. */
export const ANTIGRAVITY_HUB_DISABLED = {
  authMethod: {
    values: new Set(["oauth-personal", "oauth-business"]),
    reason: "Use the Owner's Google account through the AI gateway",
  },
} as const;
