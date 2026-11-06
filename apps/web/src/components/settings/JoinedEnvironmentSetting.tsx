import type { DesktopBridge, DesktopJoinedEnvironmentState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { errorMessageOf } from "../../lib/errorMessage";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// The joined server's connection changes on its own; polling keeps the row current while open.
const REFRESH_MS = 3_000;

type JoinedEnvironmentBridge = Pick<
  DesktopBridge,
  | "getJoinedEnvironmentState"
  | "joinAsEnvironment"
  | "cancelJoinAsEnvironment"
  | "setJoinedEnvironmentEnabled"
  | "setJoinedEnvironmentKeepRunning"
  | "leaveJoinedEnvironment"
>;

const STATUS_BADGES = {
  connected: { label: "Connected", variant: "success" },
  connecting: { label: "Connecting", variant: "warning" },
  refused: { label: "Refused", variant: "error" },
} as const;

function describe(state: DesktopJoinedEnvironmentState): string {
  if (state.joining !== null) {
    return `Approve this computer on ${state.joining.hubUrl} in your browser as its Owner. This finishes by itself.`;
  }
  if (state.repair !== null) return state.repair;
  if (state.hub === null) {
    return "Run your Hub's Threads on this computer too. It joins the Hub you name, as `t3 join` does, and keeps one connection out to it.";
  }
  const where = `${state.hub.name} on ${state.hub.url}`;
  switch (state.process) {
    case "stopped":
      return `${where}. Turned off: this computer runs nothing for the Hub.`;
    case "starting":
      return `${where}. Starting…`;
    case "failed":
      return `${where}. Its server is not starting.`;
    case "running":
      if (state.connection?.status === "connected") return `${where}.`;
      if (state.connection?.status === "refused") {
        return `${where}. The Hub refused it${state.connection.detail ? `: ${state.connection.detail}` : ""}. Leave, then join again.`;
      }
      return `${where}. Connecting${state.connection?.detail ? ` (${state.connection.detail})` : ""}…`;
  }
}

/** Desktop only: «Use this computer as an Environment», a joined server this app runs. */
export function JoinedEnvironmentSetting() {
  const bridge: JoinedEnvironmentBridge | undefined = window.desktopBridge;
  const [state, setState] = useState<DesktopJoinedEnvironmentState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [hubUrl, setHubUrl] = useState("");
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the desktop app for the joined server's live status while Settings is open.
  useEffect(() => {
    if (!bridge?.getJoinedEnvironmentState) return;
    let current = true;
    const load = () =>
      void bridge.getJoinedEnvironmentState().then(
        (next) => {
          if (current) setState(next);
        },
        (cause: unknown) => {
          if (current) setError(errorMessageOf(cause, "Could not read this setting."));
        },
      );
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [bridge]);

  if (!bridge?.getJoinedEnvironmentState || state === null) return null;

  const run = async (change: () => Promise<DesktopJoinedEnvironmentState>) => {
    setPending(true);
    setError(null);
    let done = false;
    try {
      setState(await change());
      done = true;
    } catch (cause) {
      setError(errorMessageOf(cause, "That change did not go through."));
    }
    setPending(false);
    return done;
  };

  const joined = state.hub !== null;
  const joining = state.joining !== null;
  // An unreadable `joined-hub.json`: join again over it, or leave to forget it.
  const needsRepair = state.repair !== null;
  const badge =
    state.process === "running" && state.connection !== null
      ? STATUS_BADGES[state.connection.status]
      : state.process === "failed"
        ? ({ label: "Not running", variant: "error" } as const)
        : state.process === "starting"
          ? ({ label: "Starting", variant: "outline" } as const)
          : null;
  const shownError = error ?? state.error;

  return (
    <>
      <SettingsRow
        {...searchableSetting("joined-environment")}
        status={
          joined && badge !== null ? (
            <Badge size="sm" variant={badge.variant}>
              {badge.label}
            </Badge>
          ) : null
        }
        description={describe(state)}
        control={
          <div className="flex items-center gap-2">
            {joined || needsRepair ? (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={pending}
                onClick={() => setConfirmLeave(true)}
              >
                Leave
              </Button>
            ) : null}
            {joining ? (
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => void run(() => bridge.cancelJoinAsEnvironment())}
              >
                Cancel
              </Button>
            ) : null}
            <Switch
              aria-label="Use this computer as an Environment"
              checked={joined ? state.enabled : joining || showJoinForm}
              disabled={pending || joining}
              onCheckedChange={(checked) => {
                if (joined) {
                  void run(() => bridge.setJoinedEnvironmentEnabled(checked));
                } else {
                  setShowJoinForm(checked);
                }
              }}
            />
          </div>
        }
      >
        {!joined && !joining && (showJoinForm || needsRepair) ? (
          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => bridge.joinAsEnvironment({ hubUrl: hubUrl.trim() })).then(
                (started) => started && setShowJoinForm(false),
              );
            }}
          >
            <Input
              aria-label="Hub address"
              nativeInput
              placeholder="https://hub.example.com"
              type="url"
              value={hubUrl}
              onChange={(event) => setHubUrl(event.currentTarget.value)}
            />
            <Button disabled={pending || hubUrl.trim() === ""} size="sm" type="submit">
              {needsRepair ? "Join again" : "Join"}
            </Button>
          </form>
        ) : null}
        {state.joining?.approvalUrl ? (
          <p className="mt-2 text-xs text-muted-foreground">
            The approval page did not open?{" "}
            <a
              className="underline"
              href={state.joining.approvalUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open it
            </a>{" "}
            on any device.
          </p>
        ) : null}
        {shownError ? (
          <p className="mt-2 whitespace-pre-line text-xs text-destructive">{shownError}</p>
        ) : null}
      </SettingsRow>
      {joined ? (
        <SettingsRow
          title="Keep running when the window is closed"
          description="This computer stays available to the Hub after you close T3 Code's window. Quit the app to stop it."
          control={
            <Switch
              aria-label="Keep running when the window is closed"
              checked={state.keepRunningWhenClosed}
              disabled={pending}
              onCheckedChange={(checked) =>
                void run(() => bridge.setJoinedEnvironmentKeepRunning(checked))
              }
            />
          }
        />
      ) : null}
      {confirmLeave ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : setConfirmLeave(false))}>
          <DialogPopup className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Leave the Hub?</DialogTitle>
              <DialogDescription>
                This computer stops running work for {state.hub?.url ?? "its Hub"} and the Hub
                removes it. Its Threads stay on the Hub. To come back, join again.
              </DialogDescription>
            </DialogHeader>
            {error ? (
              <p className="whitespace-pre-line px-6 text-sm text-destructive">{error}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setConfirmLeave(false)}>
                Cancel
              </Button>
              <Button
                disabled={pending}
                variant="destructive"
                onClick={() =>
                  void run(() => bridge.leaveJoinedEnvironment()).then((left) => {
                    // A Leave that failed stays open with its reason.
                    if (!left) return;
                    setConfirmLeave(false);
                    setShowJoinForm(false);
                  })
                }
              >
                Leave the Hub
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}
