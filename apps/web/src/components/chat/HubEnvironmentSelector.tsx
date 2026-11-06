import {
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { memo } from "react";

import {
  chooseHubEnvironment,
  environmentUnavailableReason,
  useHubEnvironmentChoice,
  useHubEnvironments,
} from "../../environments/primary/useHubEnvironments";
import { ComposerContextLabel } from "../ComposerContextLabel";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerSelectControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

/**
 * Where a new Thread runs, among the Hub's Environments the User may use. The Hub decides and
 * checks the choice; an Environment that is offline or lacks the provider shows why. Left alone,
 * it shows where the Hub will put the Thread: the Project's preferred Environment when the User
 * can see it, else the Hub machine.
 */
export const HubEnvironmentSelector = memo(function HubEnvironmentSelector({
  draftThreadId,
  providerInstanceId,
  preferredEnvironmentId,
}: {
  draftThreadId: string;
  providerInstanceId: ProviderInstanceId;
  preferredEnvironmentId: EnvironmentId | null;
}) {
  const environments = useHubEnvironments();
  const chosen = useHubEnvironmentChoice(draftThreadId);
  const floatingLayerProps = useComposerMenuProps();
  // One machine to pick from is no choice.
  if (environments.length < 2) return null;
  const defaultId =
    preferredEnvironmentId !== null &&
    environments.some((environment) => environment.id === preferredEnvironmentId)
      ? preferredEnvironmentId
      : HUB_MACHINE_ENVIRONMENT_ID;
  const selectedId = chosen ?? defaultId;
  const selected = environments.find((environment) => environment.id === selectedId);
  const items = environments.map((environment) => ({
    value: environment.id,
    label: environment.name,
  }));
  return (
    <Select
      modal={false}
      value={selectedId}
      onValueChange={(value) =>
        // Picking the default again leaves the choice to the Hub.
        chooseHubEnvironment(draftThreadId, value === null || value === defaultId ? null : value)
      }
      items={items}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 max-w-full"
              aria-label="Environment"
              data-composer-context-control
            />
          }
        >
          <EnvironmentMachineIcon
            kind={selected?.kind === "hub" ? "server" : "desktop"}
            className="size-3 shrink-0"
          />
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>Runs on {selected?.name ?? "the Hub machine"}</TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...floatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Run on Environment</SelectGroupLabel>
          {environments.map((environment) => {
            const reason = environmentUnavailableReason(environment, providerInstanceId);
            return (
              <SelectItem
                key={environment.id}
                value={environment.id}
                disabled={reason !== null}
                aria-label={reason === null ? environment.name : `${environment.name}, ${reason}`}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <EnvironmentMachineIcon
                    kind={environment.kind === "hub" ? "server" : "desktop"}
                    className="size-3 shrink-0"
                  />
                  <span className="truncate">{environment.name}</span>
                  {reason === null ? null : (
                    <span className="text-muted-foreground">· {reason}</span>
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
