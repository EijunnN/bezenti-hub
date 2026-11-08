import type { EnvironmentId, SandboxImageSandbox, SandboxImageStatus } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import {
  buildSandboxImage,
  fetchSandboxImageStatus,
  updateSandboxImage,
} from "../../environments/primary/sandboxImage";
import { errorMessageOf } from "../../lib/errorMessage";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { receiveBuildLog, type ShownBuildLog } from "./sandboxImageLog";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// A build reports its output as it goes; between builds the view only needs to stay current.
const BUILDING_REFRESH_MS = 1_000;
const IDLE_REFRESH_MS = 5_000;
const LOG_LINES_SHOWN = 40;

const SANDBOX_BADGES = {
  running: { label: "Running", variant: "success" },
  starting: { label: "Starting", variant: "warning" },
  stopped: { label: "Stopped", variant: "outline" },
  failed: { label: "Failed to start", variant: "error" },
} as const;

function imageDescription(status: SandboxImageStatus) {
  const { image } = status;
  const parts = [
    image.version === null
      ? `${image.image} is not built yet.`
      : `${image.image} · version ${image.version}${
          image.builtAt === null ? "" : ` · built ${new Date(image.builtAt).toLocaleString()}`
        }`,
    status.canBuild ? null : status.cannotBuildReason,
    image.version !== null && !status.runsPodmanSandboxes
      ? "Restart the Hub to run its Sandboxes from it."
      : null,
  ];
  return parts.filter((part) => part !== null).join(" ");
}

function sandboxDescription(sandbox: SandboxImageSandbox, newest: string | null) {
  if (sandbox.imageVersion === null) return "Image: none recorded yet";
  const outdated = newest !== null && sandbox.imageVersion !== newest;
  return `Image ${sandbox.imageVersion}${
    !outdated
      ? ""
      : sandbox.status === "running"
        ? " · a newer image is built"
        : " · uses the newer image at its next start"
  }`;
}

/**
 * Settings → Environments, near the Sandboxes: the base image every Sandbox runs. The Owner
 * builds it (following its output), sees each Sandbox's version and moves a running one to the
 * newest image, which the Hub refuses while a turn runs on it.
 */
export function SandboxImageSettings() {
  const session = usePrimarySessionState();
  const isOwner = session.data?.authenticated === true && session.data.isOwner === true;
  const [status, setStatus] = useState<SandboxImageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [log, setLog] = useState<ReadonlyArray<string>>([]);
  // The build the shown lines are of, and how many it had printed: the Hub sends only newer ones.
  const shown = useRef<ShownBuildLog | null>(null);
  const logRef = useRef<ReadonlyArray<string>>([]);
  const building = status?.build.state === "building";

  /** Takes a status in, appending the build's new lines (or starting over for another build). */
  const receive = (next: SandboxImageStatus, askedAfter: number | undefined) => {
    setStatus(next);
    const received = receiveBuildLog({
      shown: shown.current,
      log: logRef.current,
      build: next.build,
      askedAfter,
      keep: LOG_LINES_SHOWN,
    });
    shown.current = received.shown;
    logRef.current = received.log;
    setLog(received.log);
  };

  const polled = useEffectEvent((next: SandboxImageStatus, after: number | undefined) =>
    receive(next, after),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the Hub for the build's output and each Sandbox's image while Settings is open.
  useEffect(() => {
    if (!isOwner) return;
    let current = true;
    const load = () => {
      const after = shown.current?.lines;
      void fetchSandboxImageStatus(after).then(
        (next) => {
          if (!current) return;
          polled(next, after);
          setError(null);
        },
        (cause: unknown) => {
          if (current) setError(errorMessageOf(cause, "Could not load the Sandbox image."));
        },
      );
    };
    load();
    const timer = window.setInterval(load, building ? BUILDING_REFRESH_MS : IDLE_REFRESH_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [isOwner, building]);

  if (!isOwner) return null;

  const build = async () => {
    setPending("build");
    setError(null);
    setNotice(null);
    try {
      receive(await buildSandboxImage(), undefined);
    } catch (cause) {
      setError(errorMessageOf(cause, "The build did not start."));
    }
    setPending(null);
  };

  const update = async (sandbox: SandboxImageSandbox) => {
    setPending(sandbox.environmentId);
    setError(null);
    setNotice(null);
    try {
      const result = await updateSandboxImage(sandbox.environmentId as EnvironmentId);
      setNotice(
        result.outcome === "updated"
          ? `${sandbox.name} now runs ${result.imageVersion ?? "the new image"}.`
          : result.outcome === "up-to-date"
            ? `${sandbox.name} already runs the newest image.`
            : `${sandbox.name} is not running; it uses the newest image at its next start.`,
      );
      receive(await fetchSandboxImageStatus(), undefined);
    } catch (cause) {
      setError(errorMessageOf(cause, `${sandbox.name} was not updated.`));
    }
    setPending(null);
  };

  const newest = status?.image.version ?? null;

  return (
    <SettingsSection id="sandbox-image" title="Sandbox image">
      {status === null && error === null ? <SettingsRow title="Loading…" /> : null}
      {status !== null ? (
        <SettingsRow
          title="Base image"
          description={imageDescription(status)}
          control={
            <Button
              aria-label="Build the Sandbox image"
              disabled={building || pending !== null || !status.canBuild}
              size="xs"
              variant="outline"
              onClick={() => void build()}
            >
              {building
                ? "Building…"
                : status.image.version === null
                  ? "Build image"
                  : "Rebuild image"}
            </Button>
          }
        />
      ) : null}
      {status !== null && status.build.state !== "idle" ? (
        <SettingsRow
          title={
            status.build.state === "building"
              ? "Building the image…"
              : status.build.state === "failed"
                ? "The last build failed"
                : "The last build succeeded"
          }
          description={
            status.build.state === "failed" ? (status.build.error ?? undefined) : undefined
          }
        >
          <pre
            aria-label="Sandbox image build output"
            className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-2xs leading-4 whitespace-pre-wrap"
            role="log"
            // The newest lines are the ones to follow while it builds.
            ref={(node) => {
              if (node !== null) node.scrollTop = node.scrollHeight;
            }}
          >
            {log.join("\n")}
          </pre>
        </SettingsRow>
      ) : null}
      {(status?.sandboxes ?? []).map((sandbox) => {
        const badge = SANDBOX_BADGES[sandbox.status];
        const outdated =
          newest !== null && sandbox.imageVersion !== null && sandbox.imageVersion !== newest;
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
            description={sandboxDescription(sandbox, newest)}
            control={
              outdated && sandbox.status === "running" ? (
                <Button
                  aria-label={`Update ${sandbox.name} to the new image`}
                  disabled={pending !== null || sandbox.busy}
                  size="xs"
                  title={
                    sandbox.busy
                      ? "A turn is running in it, or work was just sent to it; update it once that ends."
                      : undefined
                  }
                  variant="outline"
                  onClick={() => void update(sandbox)}
                >
                  {pending === sandbox.environmentId ? "Updating…" : "Update"}
                </Button>
              ) : null
            }
          />
        );
      })}
      {notice ? <SettingsRow title="Done" description={notice} /> : null}
      {error ? <SettingsRow title="Something went wrong" description={error} /> : null}
    </SettingsSection>
  );
}
