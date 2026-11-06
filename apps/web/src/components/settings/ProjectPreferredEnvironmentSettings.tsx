import { type EnvironmentId, HUB_MACHINE_ENVIRONMENT_ID } from "@t3tools/contracts";
import { useState } from "react";

import { useHubEnvironments } from "../../environments/primary/useHubEnvironments";
import { useProjectGroupUpdate } from "../../hooks/useProjectGroupUpdate";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useCurrentSpace } from "../../state/currentSpace";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * «Preferred environment»: where the Project's new Threads start when nobody picks one in the
 * composer. Only machines the User may run Threads on are offered (the Hub machine, and their own
 * personal machines); the Hub checks the choice again. Someone who may not use the preferred
 * machine still starts on the Hub machine.
 */
export function ProjectPreferredEnvironmentSettings({
  group,
  canEdit,
}: {
  group: SidebarProjectSnapshot;
  canEdit: boolean;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const userId = useCurrentSpace((state) => state.view?.userId ?? null);
  const environments = useHubEnvironments();
  const { updateProjectGroup } = useProjectGroupUpdate();
  const [saving, setSaving] = useState(false);
  const project = group.memberProjects.find(
    (member) => member.environmentId === primaryEnvironmentId,
  );
  const usable = environments.filter(
    (environment) => environment.kind === "hub" || environment.ownerUserId === userId,
  );
  // With only the Hub machine there is nothing to prefer.
  if (project === undefined || usable.length < 2) return null;
  const current = project.preferredEnvironmentId ?? HUB_MACHINE_ENVIRONMENT_ID;
  const currentListed = environments.find((environment) => environment.id === current);
  const choose = async (environmentId: EnvironmentId) => {
    if (environmentId === current) return;
    setSaving(true);
    await updateProjectGroup(
      [project],
      {
        preferredEnvironmentId: environmentId === HUB_MACHINE_ENVIRONMENT_ID ? null : environmentId,
      },
      "Could not set the preferred environment",
    );
    setSaving(false);
  };

  return (
    <SettingsSection title="Environment">
      <SettingsRow
        title="Preferred environment"
        description="New Threads in this project start here unless you pick another Environment in the composer."
        control={
          <select
            aria-label="Preferred environment"
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-64"
            disabled={saving || !canEdit}
            value={current}
            onChange={(event) => void choose(event.currentTarget.value as EnvironmentId)}
          >
            {/* Someone else's machine, chosen by them, stays named but can't be picked again. */}
            {usable.some((environment) => environment.id === current) ? null : (
              <option value={current} disabled>
                {currentListed?.name ?? "An Environment you can't use"}
              </option>
            )}
            {usable.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>
        }
      />
    </SettingsSection>
  );
}
