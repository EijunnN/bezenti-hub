import { CircleAlertIcon } from "lucide-react";
import { useState } from "react";

import type { EnvironmentPresentation } from "~/state/environments";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
} from "~/versionSkew";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Machines whose server is older than this app. This build never updates them itself. */
export function useVersionMismatchBanner(
  environments: readonly EnvironmentPresentation[],
): ComposerBannerStackItem | null {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const machines = environments.flatMap((environment) => {
    const mismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
    if (!mismatch) return [];
    const dismissKey = buildVersionMismatchDismissalKey(environment.environmentId, mismatch);
    if (dismissed.has(dismissKey) || isVersionMismatchDismissed(dismissKey)) return [];
    return [{ label: environment.label, mismatch, dismissKey }];
  });
  if (machines.length === 0) return null;
  const [first] = machines;
  return {
    id: `version-mismatch-${dismissed.size}`,
    variant: "default",
    group: "environment",
    icon: <CircleAlertIcon aria-hidden />,
    title:
      machines.length === 1 && first
        ? `${first.label} runs an older T3 Code`
        : `${machines.length} machines run an older T3 Code`,
    description:
      machines.length === 1 && first
        ? `Server ${first.mismatch.serverVersion}, this app ${first.mismatch.clientVersion}. Update T3 Code on that machine.`
        : `Update T3 Code on ${machines.map(({ label }) => label).join(", ")}.`,
    dismissLabel: "Dismiss version notice",
    onDismiss: () => {
      const next = new Set(dismissed);
      for (const { dismissKey } of machines) {
        dismissVersionMismatch(dismissKey);
        next.add(dismissKey);
      }
      setDismissed(next);
    },
  };
}
