import { type EnvironmentId, HUB_MACHINE_ENVIRONMENT_ID } from "@t3tools/contracts";
import { useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { errorMessageOf } from "../../lib/errorMessage";

import { useHubEnvironments } from "../../environments/primary/useHubEnvironments";
import { useProjectGroupUpdate } from "../../hooks/useProjectGroupUpdate";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useCurrentSpace } from "../../state/currentSpace";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * «Preferred environment»: where the Project's new Threads start when nobody picks one. Offered:
 * the User's own machines, and no preference (the Space's Sandbox, or the Hub machine where it
 * runs Threads). The Hub checks the choice again.
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
  const [error, setError] = useState<string | null>(null);
  const project = group.memberProjects.find(
    (member) => member.environmentId === primaryEnvironmentId,
  );
  // No preference is the Hub machine where it runs Threads, else the Space's Sandbox.
  const hubMachine = environments.find((environment) => environment.kind === "hub");
  const spaceSandbox = environments.find(
    (environment) =>
      environment.kind === "sandbox" &&
      project !== undefined &&
      environment.spaceId === project.spaceId,
  );
  const noPreference = {
    id: HUB_MACHINE_ENVIRONMENT_ID,
    name:
      hubMachine?.name ??
      (spaceSandbox === undefined ? "No preference" : `${spaceSandbox.name} (no preference)`),
  };
  const usable = [
    noPreference,
    ...environments.filter(
      (environment) => environment.kind !== "hub" && environment.ownerUserId === userId,
    ),
  ];
  // With nothing but the default there is nothing to prefer.
  if (project === undefined || usable.length < 2) return null;
  const current = project.preferredEnvironmentId ?? HUB_MACHINE_ENVIRONMENT_ID;
  const currentListed = environments.find((environment) => environment.id === current);
  const choose = async (environmentId: EnvironmentId) => {
    if (environmentId === current) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateProjectGroup(
        [project],
        {
          preferredEnvironmentId:
            environmentId === HUB_MACHINE_ENVIRONMENT_ID ? null : environmentId,
        },
        "Could not set the preferred environment",
      );
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not save. Try again.");
      }
    } catch (cause) {
      setError(errorMessageOf(cause, "Could not save. Try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Environment">
      <SettingsRow
        title="Preferred environment"
        description={`New Threads in this project start here unless you pick another Environment in the composer. While it is offline or lacks the provider, they start ${hubMachine !== undefined ? "on the Hub machine" : "in the Space's Sandbox"}.`}
        status={
          error === null ? null : (
            <span role="alert" className="text-destructive">
              {error}
            </span>
          )
        }
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
