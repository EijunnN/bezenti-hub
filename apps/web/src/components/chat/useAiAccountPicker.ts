import type { AiAccountPickerResult, EnvironmentId, SpaceId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { aiGatewayEnvironment } from "../../state/aiGateway";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Spec 4 ticket 08: the AI accounts the User may pick for a Thread in its Space (with their
 * models), from the Hub. Null while unknown or unreadable: the composer then shows the providers
 * as the Hub reports them, and the Hub still decides and refuses on its own.
 */
export function useAiAccountPicker(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly spaceId: SpaceId | null | undefined;
  /** Where the Thread runs: a Sandbox or dedicated machine always runs on AI accounts. */
  readonly threadEnvironmentId?: EnvironmentId | null | undefined;
}): AiAccountPickerResult | null {
  const pick = useAtomCommand(aiGatewayEnvironment.pickerAccounts, "read your AI accounts");
  const [answer, setAnswer] = useState<{
    readonly key: string;
    readonly result: AiAccountPickerResult;
  } | null>(null);
  const { environmentId, spaceId, threadEnvironmentId } = input;
  const key = `${environmentId ?? ""}|${spaceId ?? ""}|${threadEnvironmentId ?? ""}`;
  const load = useEffectEvent(
    (target: EnvironmentId, space: SpaceId, machine: EnvironmentId | null | undefined) =>
      pick({
        environmentId: target,
        input: { spaceId: space, ...(machine == null ? {} : { environmentId: machine }) },
      }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads from the Hub, once per Space and machine, which AI accounts the composer may offer.
  useEffect(() => {
    if (environmentId === undefined || spaceId == null) return;
    let cancelled = false;
    void load(environmentId, spaceId, threadEnvironmentId).then((result) => {
      if (cancelled || result._tag !== "Success") return;
      setAnswer({ key, result: result.value });
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, spaceId, threadEnvironmentId, key]);
  return answer !== null && answer.key === key ? answer.result : null;
}
