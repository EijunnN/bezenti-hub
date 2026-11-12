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

/**
 * Settings → AI gateway (the Owner's): the CLIProxyAPI release the Hub runs, its state, and
 * updating or rolling it back. GitHub is asked for the newest release only while this is open.
 */
export function AiGatewaySettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : aiGatewayEnvironment.status({ environmentId, input: {} }),
  );
  // Asked when the section opens and on «Check for updates»; never in the background (ADR 0007).
  const latestQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : aiGatewayEnvironment.checkForUpdates({ environmentId, input: {} }),
  );
  const update = useAtomCommand(aiGatewayEnvironment.update, { reportFailure: false });
  const rollback = useAtomCommand(aiGatewayEnvironment.rollback, { reportFailure: false });
  const [pending, setPending] = useState<"update" | "rollback" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks the uptime shown once a second.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const act = async (kind: "update" | "rollback", version: string | null) => {
    if (environmentId === null) return;
    setPending(kind);
    setError(null);
    const result =
      kind === "update" && version !== null
        ? await update({ environmentId, input: { version } })
        : await rollback({ environmentId, input: {} });
    setPending(null);
    if (result._tag === "Success") {
      query.refresh();
      latestQuery.refresh();
    } else {
      setError(failureMessage(result.cause));
    }
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

  const manages = status.state !== "off" && status.state !== "unsupported";
  const latest = latestQuery.data;
  const latestVersion = latest?.updateAvailable === true ? latest.latestVersion : null;
  const shownError = error ?? latestQuery.error;
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
        <SettingsRow
          title="Version"
          description={
            status.version === status.pinnedVersion || status.version === null
              ? `This Hub pins CLIProxyAPI ${status.pinnedVersion}.`
              : `This Hub pins ${status.pinnedVersion}; the Owner moved it to ${status.version}.`
          }
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
                ? "Not restarted since the Hub started."
                : `Restarted ${status.restarts} ${status.restarts === 1 ? "time" : "times"} since the Hub started.`
            }
            control={<span className="text-sm">{uptimeLabel(status.startedAt, now)}</span>}
          />
        ) : null}
        {manages && !status.credentialsInMemory ? (
          <SettingsRow
            title="Credentials on disk"
            description="This machine has no folder in memory ($XDG_RUNTIME_DIR or /dev/shm), so the gateway's subscription credentials are kept on its disk, readable only by the Hub's user."
          />
        ) : null}
        {manages ? (
          <SettingsRow
            title={latestVersion === null ? "Updates" : `CLIProxyAPI ${latestVersion} is available`}
            description={
              latest === null
                ? "Asks GitHub for the newest release; nothing is downloaded until you update."
                : latestVersion === null
                  ? `Up to date: ${latest.latestVersion} is the newest release.`
                  : "Downloads it, checks its checksum, starts it beside the current one and switches once it answers. The current one is kept to roll back."
            }
            status={
              shownError === null ? null : (
                <span className="text-destructive" role="alert">
                  {shownError}
                </span>
              )
            }
            control={
              <div className="flex flex-wrap justify-end gap-2">
                {status.previousVersion !== null ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending !== null}
                    onClick={() => void act("rollback", null)}
                  >
                    {`Roll back to ${status.previousVersion}`}
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
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending !== null || latestQuery.isPending}
                    onClick={() => latestQuery.refresh()}
                  >
                    {latestQuery.isPending ? "Checking…" : "Check for updates"}
                  </Button>
                )}
              </div>
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
