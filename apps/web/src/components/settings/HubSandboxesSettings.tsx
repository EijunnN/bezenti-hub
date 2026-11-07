import type {
  EnvironmentId,
  HubSandboxDetail,
  HubSandboxList,
  SandboxLimitEnforcement,
  SandboxLimits,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import {
  fetchHubSandboxes,
  runHubSandboxAction,
  setHubSandboxLimits,
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

// Status and use are read on the Hub; polling keeps them current while Settings is open.
const REFRESH_MS = 5_000;
const GIB = 1024 ** 3;

const STATUS_BADGES = {
  online: { label: "Running", variant: "success" },
  reconnecting: { label: "Reconnecting", variant: "warning" },
  offline: { label: "Offline", variant: "outline" },
  stopped: { label: "Stopped", variant: "outline" },
  starting: { label: "Starting", variant: "warning" },
  failed: { label: "Failed", variant: "error" },
} as const;

const bytes = (value: number) =>
  value >= GIB ? `${(value / GIB).toFixed(1)} GiB` : `${Math.round(value / 1024 ** 2)} MiB`;

function uptime(startedAt: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${hours} h ${minutes % 60} min`
    : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** «2 CPUs · 4.0 GiB memory · …», marking what this host does not enforce. */
function describeLimits(limits: SandboxLimits, enforcement: SandboxLimitEnforcement) {
  const mark = (enforced: boolean) => (enforced ? "" : " (not enforced)");
  return [
    `${limits.cpus === null ? "no CPU limit" : `${limits.cpus} CPUs`}${mark(enforcement.cpus)}`,
    `${limits.memoryBytes === null ? "no memory limit" : `${bytes(limits.memoryBytes)} memory`}${mark(enforcement.memory)}`,
    `${limits.pids === null ? "no process limit" : `${limits.pids} processes`}${mark(enforcement.pids)}`,
    `${limits.diskBytes === null ? "no disk limit" : `${bytes(limits.diskBytes)} disk`}${mark(enforcement.disk)}`,
  ].join(" · ");
}

function describeSandbox(sandbox: HubSandboxDetail, enforcement: SandboxLimitEnforcement) {
  const usage = sandbox.usage;
  const use = [
    sandbox.startedAt === null ? null : `Up ${uptime(sandbox.startedAt, Date.now())}`,
    usage.cpuPercent === null ? null : `CPU ${usage.cpuPercent}%`,
    usage.memoryBytes === null ? null : `Memory ${bytes(usage.memoryBytes)}`,
    usage.diskBytes === null
      ? null
      : `Disk ${bytes(usage.diskBytes)}${
          sandbox.limits.diskBytes === null ? "" : ` of ${bytes(sandbox.limits.diskBytes)}`
        }`,
  ].filter((part) => part !== null);
  return (
    <>
      {use.length > 0 ? use.join(" · ") : "Not running"}
      <br />
      {`Limits: ${describeLimits(sandbox.limits, enforcement)}`}
      <br />
      {`Image: ${sandbox.imageVersion ?? "not recorded"} · ${sandbox.runtime} runtime`}
      {sandbox.error !== null ? (
        <>
          <br />
          <span className="text-destructive-foreground">{sandbox.error}</span>
        </>
      ) : null}
    </>
  );
}

/** The dialog's fields: text as typed, blank for «the default» (or «no limit» for the defaults). */
interface LimitFields {
  readonly cpus: string;
  readonly memoryGib: string;
  readonly pids: string;
  readonly diskGib: string;
}

const toFields = (limits: SandboxLimits): LimitFields => ({
  cpus: limits.cpus === null ? "" : String(limits.cpus),
  memoryGib: limits.memoryBytes === null ? "" : String(+(limits.memoryBytes / GIB).toFixed(2)),
  pids: limits.pids === null ? "" : String(limits.pids),
  diskGib: limits.diskBytes === null ? "" : String(+(limits.diskBytes / GIB).toFixed(2)),
});

/** The limits typed, or why they are not valid. */
function fromFields(fields: LimitFields): SandboxLimits | string {
  const number = (text: string, label: string, integer: boolean) => {
    const trimmed = text.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
      return `${label} must be a positive ${integer ? "whole number" : "number"}.`;
    }
    return value;
  };
  const cpus = number(fields.cpus, "CPUs", false);
  const memory = number(fields.memoryGib, "Memory", false);
  const pids = number(fields.pids, "Processes", true);
  const disk = number(fields.diskGib, "Disk", false);
  for (const value of [cpus, memory, pids, disk]) if (typeof value === "string") return value;
  return {
    cpus: cpus as number | null,
    memoryBytes: memory === null ? null : Math.round((memory as number) * GIB),
    pids: pids as number | null,
    diskBytes: disk === null ? null : Math.round((disk as number) * GIB),
  };
}

interface Editing {
  /** Undefined: the Installation's defaults. */
  readonly environmentId: EnvironmentId | undefined;
  readonly title: string;
  readonly fields: LimitFields;
}

/**
 * Settings → Environments «Sandboxes»: each Space's Sandbox with its status, uptime, use, limits
 * and image. The Owner sees every one, starts, stops and restarts them and changes their limits
 * and the defaults; an Admin sees their Space's, read-only.
 */
export function HubSandboxesSettings() {
  const session = usePrimarySessionState();
  const signedIn = session.data?.authenticated === true;
  const [list, setList] = useState<HubSandboxList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>();
  const [pending, setPending] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the Hub for each Sandbox's live status and use while Settings is open.
  useEffect(() => {
    if (!signedIn) return;
    let current = true;
    const load = () =>
      void fetchHubSandboxes().then(
        (next) => {
          if (!current) return;
          setList(next);
          setError(null);
        },
        (cause: unknown) => {
          if (current) setError(errorMessageOf(cause, "Could not load this Hub's Sandboxes."));
        },
      );
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [signedIn]);

  // Only someone who sees a Sandbox or manages them gets the section.
  if (!signedIn || list === null || (list.sandboxes.length === 0 && !list.manageable)) {
    return error !== null && signedIn ? (
      <SettingsSection id="hub-sandboxes" title="Sandboxes">
        <SettingsRow title="Something went wrong" description={error} />
      </SettingsSection>
    ) : null;
  }

  const run = async (change: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await change();
      setEditing(undefined);
    } catch (cause) {
      setError(errorMessageOf(cause, "That change did not go through."));
    }
    setPending(false);
  };

  const act = (sandbox: HubSandboxDetail, action: "start" | "stop" | "restart") =>
    void run(async () => {
      const updated = await runHubSandboxAction(sandbox.environmentId, action);
      setList((previous) =>
        previous === null
          ? previous
          : {
              ...previous,
              sandboxes: previous.sandboxes.map((entry) =>
                entry.environmentId === updated.environmentId ? updated : entry,
              ),
            },
      );
    });

  const parsed = editing === undefined ? undefined : fromFields(editing.fields);
  const field = (key: keyof LimitFields, label: string, hint: string) =>
    editing === undefined ? null : (
      <div className="grid gap-1">
        <label className="text-xs font-medium" htmlFor={`sandbox-limit-${key}`}>
          {label}
        </label>
        <Input
          id={`sandbox-limit-${key}`}
          inputMode="decimal"
          nativeInput
          placeholder={hint}
          value={editing.fields[key]}
          onChange={(event) =>
            setEditing({
              ...editing,
              fields: { ...editing.fields, [key]: event.currentTarget.value },
            })
          }
        />
      </div>
    );

  return (
    <SettingsSection id="hub-sandboxes" title="Sandboxes">
      {list.enforcement.note !== null ? (
        <SettingsRow
          title={
            <span className="flex items-center gap-2">
              Limits not enforced on this host
              <Badge size="sm" variant="warning">
                Warning
              </Badge>
            </span>
          }
          description={list.enforcement.note}
        />
      ) : null}
      {list.manageable ? (
        <SettingsRow
          title="Default limits"
          description={`Every Sandbox without its own: ${describeLimits(list.defaults, list.enforcement)}. Changes apply on each Sandbox's next start; the disk limit at once.`}
          control={
            <Button
              aria-label="Change default limits"
              size="xs"
              variant="outline"
              onClick={() =>
                setEditing({
                  environmentId: undefined,
                  title: "Default Sandbox limits",
                  fields: toFields(list.defaults),
                })
              }
            >
              Change
            </Button>
          }
        />
      ) : null}
      {list.sandboxes.length === 0 ? (
        <SettingsRow
          title="No Sandboxes yet"
          description="A Space's Sandbox is made when its first Thread runs there."
        />
      ) : null}
      {list.sandboxes.map((sandbox) => {
        const badge = STATUS_BADGES[sandbox.status];
        const running = sandbox.status === "online" || sandbox.status === "reconnecting";
        const busy = pending || sandbox.status === "starting";
        return (
          <SettingsRow
            key={sandbox.environmentId}
            title={
              <span className="flex items-center gap-2">
                {sandbox.name}
                <Badge size="sm" variant={badge.variant}>
                  {badge.label}
                </Badge>
              </span>
            }
            description={describeSandbox(sandbox, list.enforcement)}
            control={
              sandbox.manageable ? (
                <div className="flex flex-wrap gap-1">
                  {running ? (
                    <>
                      <Button
                        aria-label={`Restart ${sandbox.name}`}
                        disabled={busy}
                        size="xs"
                        variant="outline"
                        onClick={() => act(sandbox, "restart")}
                      >
                        Restart
                      </Button>
                      <Button
                        aria-label={`Stop ${sandbox.name}`}
                        disabled={busy}
                        size="xs"
                        variant="outline"
                        onClick={() => act(sandbox, "stop")}
                      >
                        Stop
                      </Button>
                    </>
                  ) : (
                    <Button
                      aria-label={`Start ${sandbox.name}`}
                      disabled={busy}
                      size="xs"
                      variant="outline"
                      onClick={() => act(sandbox, "start")}
                    >
                      Start
                    </Button>
                  )}
                  <Button
                    aria-label={`Change limits of ${sandbox.name}`}
                    disabled={pending}
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      setEditing({
                        environmentId: sandbox.environmentId,
                        title: `Limits of ${sandbox.name}`,
                        fields: toFields(sandbox.overrides),
                      })
                    }
                  >
                    Limits
                  </Button>
                </div>
              ) : null
            }
          />
        );
      })}
      {error ? <SettingsRow title="Something went wrong" description={error} /> : null}
      {editing !== undefined ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : setEditing(undefined))}>
          <DialogPopup className="sm:max-w-sm">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (parsed === undefined || typeof parsed === "string") return;
                void run(async () => {
                  setList(await setHubSandboxLimits(editing.environmentId, parsed));
                });
              }}
            >
              <DialogHeader>
                <DialogTitle>{editing.title}</DialogTitle>
                <DialogDescription>
                  {editing.environmentId === undefined
                    ? "Leave a field blank for no limit."
                    : "Leave a field blank to use the default."}{" "}
                  CPU, memory and process limits apply on its next start; the disk limit at once.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <div className="grid gap-3">
                  {field("cpus", "CPUs", "e.g. 2")}
                  {field("memoryGib", "Memory (GiB)", "e.g. 4")}
                  {field("pids", "Processes and threads", "e.g. 4096")}
                  {field("diskGib", "Disk (GiB)", "e.g. 20")}
                  {typeof parsed === "string" ? (
                    <p className="text-destructive-foreground text-xs">{parsed}</p>
                  ) : null}
                </div>
              </DialogPanel>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setEditing(undefined)}>
                  Cancel
                </Button>
                <Button disabled={pending || typeof parsed === "string"} type="submit">
                  Save limits
                </Button>
              </DialogFooter>
            </form>
          </DialogPopup>
        </Dialog>
      ) : null}
    </SettingsSection>
  );
}
