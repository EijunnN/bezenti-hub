import type { EnvironmentId, ProviderInstanceId, SpaceId } from "@t3tools/contracts";
import { memo } from "react";

import {
  chooseHubEnvironment,
  environmentUnavailableReason,
  placeableEnvironments,
  useHubEnvironmentChoice,
  useHubEnvironments,
  previewDefaultEnvironment,
} from "../../environments/primary/useHubEnvironments";
import { useCurrentSpace } from "../../state/currentSpace";
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
 * Where a new Thread runs, among the Environments the User may use for the Project's Space (the
 * Hub decides and checks). Left alone it shows the Hub's own default (`previewThreadPlacement`);
 * a pick is sent as the User's choice. A stopped Sandbox is offered: sending starts it.
 */
export const HubEnvironmentSelector = memo(function HubEnvironmentSelector({
  draftThreadId,
  providerInstanceId,
  preferredEnvironmentId,
  spaceId,
}: {
  draftThreadId: string;
  providerInstanceId: ProviderInstanceId;
  preferredEnvironmentId: EnvironmentId | null;
  /** The Project's Space; null for a Project from before Spaces, the Owner's Personal space. */
  spaceId: SpaceId | null;
}) {
  const userId = useCurrentSpace((state) => state.view?.userId ?? null);
  const ownersSpaceId = useCurrentSpace((state) =>
    state.view?.isOwner === true ? state.view.personalSpaceId : null,
  );
  const environments = placeableEnvironments(useHubEnvironments(), spaceId ?? ownersSpaceId);
  const chosen = useHubEnvironmentChoice(draftThreadId);
  const floatingLayerProps = useComposerMenuProps();
  // One machine to pick from is no choice.
  if (environments.length < 2) return null;
  const defaultId = previewDefaultEnvironment({
    environments,
    preferredEnvironmentId,
    providerInstanceId,
    userId,
  });
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
      onValueChange={(value) => chooseHubEnvironment(draftThreadId, value)}
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
            kind={selected === undefined || selected.kind !== "external" ? "server" : "desktop"}
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
                    kind={environment.kind === "external" ? "desktop" : "server"}
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
