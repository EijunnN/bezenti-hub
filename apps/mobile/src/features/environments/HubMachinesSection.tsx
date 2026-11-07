import { ENVIRONMENT_STATUS_LABELS } from "@t3tools/client-runtime/environment/hub-environments";
import type { HubEnvironmentSummary } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListSection } from "../../components/ui/ListSection";
import { useHubEnvironments } from "../../state/hubEnvironments";
import { useSpaceSelections } from "../../state/spaces";
import { useHubConnection } from "../../state/use-remote-environment-registry";
import { EnvironmentStatusDot } from "./EnvironmentStatusDot";

/** What one machine's row says: its status, system and how many Threads run there. */
export function hubMachineDetails(environment: HubEnvironmentSummary): string {
  const status = environment.kind === "hub" ? "online" : environment.status;
  const running =
    environment.runningThreadCount === 0
      ? null
      : `${environment.runningThreadCount} running ${environment.runningThreadCount === 1 ? "Thread" : "Threads"}`;
  return [
    environment.kind === "hub" ? "This Hub" : ENVIRONMENT_STATUS_LABELS[status],
    environment.os,
    running,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * «Machines on this Hub», for the Owner: each Environment with its live status, to read only.
 * Renaming, removing and approving machines stay on the web and desktop app.
 */
export function HubMachinesSection() {
  const hub = useHubConnection();
  const selections = useSpaceSelections();
  const isOwner = hub !== null && selections.get(hub.environmentId)?.view?.isOwner === true;
  if (!isOwner) return null;
  return <HubMachinesList />;
}

function HubMachinesList() {
  const environments = useHubEnvironments();
  return (
    <ListSection
      title="Machines on this Hub"
      footer="Machines join with `t3 join`. Rename or remove them from the web or desktop app."
    >
      {environments.length === 0 ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">Loading machines…</Text>
      ) : (
        environments.map((environment) => {
          const details = hubMachineDetails(environment);
          return (
            <View
              key={environment.id}
              accessible
              accessibilityLabel={`${environment.name}, ${details}`}
              className="flex-row items-center gap-3 px-4 py-3"
            >
              <EnvironmentStatusDot
                status={environment.kind === "hub" ? "online" : environment.status}
              />
              <View className="flex-1">
                <Text className="text-base">{environment.name}</Text>
                <Text className="text-xs text-foreground-muted">{details}</Text>
              </View>
            </View>
          );
        })
      )}
    </ListSection>
  );
}
