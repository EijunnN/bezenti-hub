import type { AiGatewayState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useState } from "react";

import { aiGatewayEnvironment } from "../../state/aiGateway";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const STATE_LABELS: Readonly<Record<AiGatewayState, string>> = {
  off: "Off",
  unsupported: "Not available on this platform",
  installing: "Installing",
  starting: "Starting",
  running: "Running",
  restarting: "Restarting",
  failed: "Failed",
};

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

function uptimeLabel(startedAt: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}

type Action = "update" | "rollback" | "enable" | "disable";

/**
 * Settings → AI gateway (the Owner's): the pinned CLIProxyAPI release the Hub runs, its state as
 * it changes, switching between the releases this Hub pins, and turning it on or off where the
 * Owner decides (the desktop app). Nothing here asks GitHub.
 */
export function AiGatewaySettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : aiGatewayEnvironment.status({ environmentId, input: {} }),
  );
  const latestQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : aiGatewayEnvironment.checkForUpdates({ environmentId, input: {} }),
  );
  const update = useAtomCommand(aiGatewayEnvironment.update, { reportFailure: false });
  const rollback = useAtomCommand(aiGatewayEnvironment.rollback, { reportFailure: false });
  const setEnabled = useAtomCommand(aiGatewayEnvironment.setEnabled, { reportFailure: false });
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks the uptime shown once a second.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const act = async (kind: Action, version: string | null) => {
    if (environmentId === null) return;
    setPending(kind);
    setError(null);
    const result =
      kind === "update" && version !== null
        ? await update({ environmentId, input: { version } })
        : kind === "rollback"
          ? await rollback({ environmentId, input: {} })
          : await setEnabled({ environmentId, input: { enabled: kind === "enable" } });
    setPending(null);
    if (result._tag === "Success") latestQuery.refresh();
    else setError(failureMessage(result.cause));
  };

  const status = query.data;
  if (status === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection id="ai-gateway" title="AI gateway">
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {query.error ?? "Reading the AI gateway's status…"}
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const on = status.state !== "off" && status.state !== "unsupported";
  const latest = latestQuery.data;
  const latestVersion = latest?.updateAvailable === true ? latest.latestVersion : null;
  const errorRow =
    error === null ? null : (
      <span className="text-destructive" role="alert">
        {error}
      </span>
    );
  return (
    <SettingsPageContainer>
      <SettingsSection id="ai-gateway" title="AI gateway">
        <SettingsRow
          title="Status"
          description="CLIProxyAPI, run by this Hub on its own loopback address. Only the Hub reaches it."
          control={
            <span role="status" aria-label="AI gateway status" className="text-sm font-medium">
              {STATE_LABELS[status.state]}
            </span>
          }
          status={
            status.lastError === null ? null : (
              <span className={status.state === "failed" ? "text-destructive" : undefined}>
                {status.lastError}
              </span>
            )
          }
        />
        {status.switchable ? (
          <SettingsRow
            title="Run on this machine"
            description="Agents reach your AI accounts through the gateway. Off until you turn it on in the desktop app."
            status={on ? null : errorRow}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void act(on ? "disable" : "enable", null)}
              >
                {on ? "Turn off" : "Turn on"}
              </Button>
            }
          />
        ) : null}
        <SettingsRow
          title="Version"
          description={`This Hub pins CLIProxyAPI ${status.pinnedVersions.join(", ")}; it runs only those.`}
          control={
            <span aria-label="AI gateway version" className="font-mono text-sm">
              {status.version ?? "none"}
            </span>
          }
        />
        {status.state === "running" && status.startedAt !== null ? (
          <SettingsRow
            title="Uptime"
            description={
              status.restarts === 0
                ? "Not restarted since it started."
                : `Restarted ${status.restarts} ${status.restarts === 1 ? "time" : "times"} since it started.`
            }
            control={<span className="text-sm">{uptimeLabel(status.startedAt, now)}</span>}
          />
        ) : null}
        {on && !status.credentialsInMemory ? (
          <SettingsRow
            title="No folder in memory"
            description="This machine has no folder in memory ($XDG_RUNTIME_DIR or /dev/shm). The gateway's config (with its keys) is on the disk, readable only by the Hub's user, and subscriptions are not loaded or signed in: their tokens would sit on the disk in clear. API keys still work."
          />
        ) : null}
        {on ? (
          <SettingsRow
            title={latestVersion === null ? "Release" : `CLIProxyAPI ${latestVersion} is pinned`}
            description={
              latestVersion === null
                ? "Runs the newest release this Hub pins. A newer one comes with a Hub update."
                : "Starts it beside the current one and switches once it answers. The current one is kept to roll back."
            }
            status={errorRow}
            control={
              <div className="flex flex-wrap justify-end gap-2">
                {status.previousVersion !== null ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending !== null}
                    onClick={() => void act("rollback", null)}
                  >
                    {pending === "rollback"
                      ? "Rolling back…"
                      : `Roll back to ${status.previousVersion}`}
                  </Button>
                ) : null}
                {latestVersion !== null ? (
                  <Button
                    size="xs"
                    disabled={pending !== null}
                    onClick={() => void act("update", latestVersion)}
                  >
                    {pending === "update" ? "Updating…" : `Update to ${latestVersion}`}
                  </Button>
                ) : null}
              </div>
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
