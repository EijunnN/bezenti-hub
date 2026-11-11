import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListSection } from "../../components/ui/ListSection";
import { useHubEnvironmentOverview } from "../../state/hubEnvironmentOverview";
import { useSpaceSelections } from "../../state/spaces";
import { useHubConnection } from "../../state/use-remote-environment-registry";
import { EnvironmentStatusDot } from "./EnvironmentStatusDot";
import { hubMachineRow } from "./hubMachineRow";

/**
 * «Machines on this Hub», for the Owner only: every Environment with how it is used, its Space and
 * live status, to read only. Its list comes from an endpoint only the Owner gets. Renaming,
 * removing, dedicating and approving machines stay on the web and desktop app.
 */
export function HubMachinesSection() {
  const hub = useHubConnection();
  const selections = useSpaceSelections();
  const isOwner = hub !== null && selections.get(hub.environmentId)?.view?.isOwner === true;
  if (!isOwner || hub === null) return null;
  return <HubMachinesList connection={hub} />;
}

function HubMachinesList(props: {
  readonly connection: NonNullable<ReturnType<typeof useHubConnection>>;
}) {
  const { environments, failed, refresh } = useHubEnvironmentOverview(props.connection);
  return (
    <ListSection title="Machines on this Hub">
      {failed ? (
        <View accessibilityRole="alert" className="flex-row items-center gap-3 px-4 py-3">
          <Text className="flex-1 text-sm text-danger-foreground">
            Could not load this Hub's machines.
          </Text>
          <Button label="Try again" size="compact" tone="secondary" onPress={refresh} />
        </View>
      ) : null}
      {environments === null ? (
        failed ? null : (
          <Text className="px-4 py-3 text-sm text-foreground-muted">Loading machines…</Text>
        )
      ) : (
        environments.map((environment) => {
          const row = hubMachineRow(environment);
          return (
            <View
              key={environment.id}
              accessible
              accessibilityLabel={row.accessibilityLabel}
              className="flex-row items-center gap-3 px-4 py-3"
            >
              <EnvironmentStatusDot status={row.status} />
              <View className="flex-1">
                <View className="flex-row items-center gap-2">
                  <Text className="flex-shrink text-base" numberOfLines={1}>
                    {environment.name}
                  </Text>
                  <Text className="text-xs text-foreground-muted">{row.mode}</Text>
                </View>
                <Text className="text-xs text-foreground-muted">{row.details}</Text>
                {row.error === null ? null : (
                  <Text className="text-xs text-danger-foreground">{row.error}</Text>
                )}
              </View>
            </View>
          );
        })
      )}
      <Text className="px-4 pb-3 text-xs text-foreground-muted">
        Machines join with <Text className="font-mono text-xs">t3 join</Text>. Rename, remove or
        dedicate them from the web or desktop app.
      </Text>
    </ListSection>
  );
}
