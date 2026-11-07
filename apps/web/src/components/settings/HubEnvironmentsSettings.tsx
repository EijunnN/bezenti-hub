import type { HubEnvironmentSummary } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import {
  fetchHubEnvironments,
  removeHubEnvironment,
  renameHubEnvironment,
} from "../../environments/primary/hubEnvironments";
import { errorMessageOf } from "../../lib/errorMessage";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// The list's status is computed on the Hub from heartbeats; polling keeps it current while open.
const REFRESH_MS = 5_000;

const STATUS_BADGES = {
  online: { label: "Online", variant: "success" },
  reconnecting: { label: "Reconnecting", variant: "warning" },
  offline: { label: "Offline", variant: "outline" },
  stopped: { label: "Stopped", variant: "outline" },
} as const;

const gigabytes = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`;

function describe(environment: HubEnvironmentSummary) {
  const parts = [
    environment.kind === "hub"
      ? "Runs the Hub"
      : environment.kind === "sandbox"
        ? "Sandbox"
        : "Personal",
    environment.os,
    environment.lastSeenAt === null
      ? "never connected"
      : environment.kind === "hub"
        ? null
        : `last seen ${new Date(environment.lastSeenAt).toLocaleString()}`,
    `${environment.runningThreadCount} running Threads`,
  ];
  const resources = environment.resources;
  const providers = environment.providers
    .filter((provider) => provider.installed)
    .map((provider) =>
      provider.version === null
        ? provider.instanceId
        : `${provider.instanceId} ${provider.version}`,
    );
  return (
    <>
      {parts.filter((part) => part !== null).join(" · ")}
      {resources !== null ? (
        <>
          <br />
          {`${resources.hostResources.cpuCount} CPUs${
            resources.hostResources.cpuUtilization === null
              ? ""
              : ` (${Math.round(resources.hostResources.cpuUtilization * 100)}% busy)`
          } · ${gigabytes(resources.hostResources.availableMemoryBytes)} of ${gigabytes(
            resources.hostResources.totalMemoryBytes,
          )} memory free${
            resources.disk === null
              ? ""
              : ` · ${gigabytes(resources.disk.availableBytes)} of ${gigabytes(resources.disk.totalBytes)} disk free`
          }`}
        </>
      ) : null}
      {providers.length > 0 ? (
        <>
          <br />
          {`Providers: ${providers.join(", ")}`}
        </>
      ) : null}
    </>
  );
}

/** Settings → Environments: the machines joined to this Hub. The Owner's. */
export function HubEnvironmentsSettings() {
  const session = usePrimarySessionState();
  const isOwner = session.data?.authenticated === true && session.data.isOwner === true;
  const [environments, setEnvironments] = useState<ReadonlyArray<HubEnvironmentSummary> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly name: string }>();
  const [removing, setRemoving] = useState<HubEnvironmentSummary>();
  const [pending, setPending] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the Hub for each machine's live status while Settings is open.
  useEffect(() => {
    if (!isOwner) return;
    let current = true;
    const load = () =>
      void fetchHubEnvironments().then(
        (list) => {
          if (!current) return;
          setEnvironments(list.environments);
          setError(null);
        },
        (cause: unknown) => {
          if (current) setError(errorMessageOf(cause, "Could not load this Hub's Environments."));
        },
      );
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [isOwner]);

  if (!isOwner) return null;

  const run = async (change: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await change();
      setRenaming(undefined);
      setRemoving(undefined);
    } catch (cause) {
      setError(errorMessageOf(cause, "That change did not go through."));
    }
    setPending(false);
  };

  return (
    <SettingsSection id="hub-environments" title="Machines on this Hub">
      {environments === null && error === null ? <SettingsRow title="Loading…" /> : null}
      {(environments ?? [])
        // A Space's Sandbox is listed once it has run; until then it is only a choice in the composer.
        .filter((environment) => environment.kind !== "sandbox" || environment.lastSeenAt !== null)
        .map((environment) => {
          const badge = STATUS_BADGES[environment.status];
          return (
            <SettingsRow
              key={environment.id}
              title={
                <span className="flex items-center gap-2">
                  {environment.name}
                  <Badge size="sm" variant={badge.variant}>
                    {badge.label}
                  </Badge>
                </span>
              }
              description={describe(environment)}
              control={
                <div className="flex gap-1">
                  {environment.kind === "sandbox" ? null : (
                    <Button
                      aria-label={`Rename ${environment.name}`}
                      size="xs"
                      variant="outline"
                      onClick={() => setRenaming({ id: environment.id, name: environment.name })}
                    >
                      Rename
                    </Button>
                  )}
                  {environment.kind === "external" ? (
                    <Button
                      aria-label={`Remove ${environment.name}`}
                      size="xs"
                      variant="destructive-outline"
                      onClick={() => setRemoving(environment)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              }
            />
          );
        })}
      <SettingsRow
        title="Add a machine"
        description="Run `t3 join <this Hub's address>` on it, then approve it here in the browser."
      />
      {error ? <SettingsRow title="Something went wrong" description={error} /> : null}
      {renaming !== undefined ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : setRenaming(undefined))}>
          <DialogPopup className="sm:max-w-sm">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const environment = environments?.find((entry) => entry.id === renaming.id);
                if (environment === undefined) return;
                void run(async () => {
                  const renamed = await renameHubEnvironment(environment.id, renaming.name.trim());
                  setEnvironments(
                    (list) =>
                      list?.map((entry) => (entry.id === renamed.id ? renamed : entry)) ?? null,
                  );
                });
              }}
            >
              <DialogHeader>
                <DialogTitle>Rename environment</DialogTitle>
              </DialogHeader>
              <DialogPanel>
                <label className="text-xs font-medium" htmlFor="hub-environment-name">
                  Name
                </label>
                <Input
                  id="hub-environment-name"
                  maxLength={64}
                  nativeInput
                  value={renaming.name}
                  onChange={(event) =>
                    setRenaming({ id: renaming.id, name: event.currentTarget.value })
                  }
                />
              </DialogPanel>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setRenaming(undefined)}>
                  Cancel
                </Button>
                <Button disabled={pending || renaming.name.trim() === ""} type="submit">
                  Save
                </Button>
              </DialogFooter>
            </form>
          </DialogPopup>
        </Dialog>
      ) : null}
      {removing !== undefined ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : setRemoving(undefined))}>
          <DialogPopup className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>{`Remove ${removing.name}?`}</DialogTitle>
              <DialogDescription>
                It disconnects now and its credential stops working. To add it again, run `t3 join`
                on it.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRemoving(undefined)}>
                Cancel
              </Button>
              <Button
                disabled={pending}
                variant="destructive"
                onClick={() =>
                  void run(async () => {
                    const list = await removeHubEnvironment(removing.id);
                    setEnvironments(list.environments);
                  })
                }
              >
                Remove machine
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </SettingsSection>
  );
}
