// @effect-diagnostics nodeBuiltinImport:off -- measures homes with `du` and the host with statfs.
/**
 * A Sandbox's limits: the Installation's defaults, a Space's override over them, and the disk
 * check the Hub runs itself (a home is a plain directory, so no runtime limits its size). Pure but
 * for the measurements (`measureWithDu`, `hostSpaceOf`, `hostCapacity`). See docs/internals/sandboxes.md#limits.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { SandboxLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export type { SandboxLimits };

export const NO_LIMITS: SandboxLimits = {
  cpus: null,
  memoryBytes: null,
  pids: null,
  diskBytes: null,
};

/** What migration 104 seeds: 2 CPUs, 4 GiB of memory, 4096 processes and threads, 20 GiB of disk. */
export const BUILT_IN_DEFAULT_LIMITS: SandboxLimits = {
  cpus: 2,
  memoryBytes: 4 * 1024 ** 3,
  pids: 4096,
  diskBytes: 20 * 1024 ** 3,
};

/** The limits a Sandbox starts with: each of the Space's own values, else the default. */
export const effectiveLimits = (
  defaults: SandboxLimits,
  overrides: SandboxLimits,
): SandboxLimits => ({
  cpus: overrides.cpus ?? defaults.cpus,
  memoryBytes: overrides.memoryBytes ?? defaults.memoryBytes,
  pids: overrides.pids ?? defaults.pids,
  diskBytes: overrides.diskBytes ?? defaults.diskBytes,
});

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** «20 GiB», «1.5 GiB», «300 MiB». */
export const formatBytes = (bytes: number) => {
  if (bytes < GIB) return `${Math.round(bytes / MIB)} MiB`;
  const value = bytes / GIB;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} GiB`;
};

/** The least a Sandbox runs with: below these its server and agents do not work. */
const SANDBOX_LIMIT_FLOORS = {
  cpus: 0.1,
  memoryBytes: 256 * MIB,
  pids: 64,
  diskBytes: GIB,
} as const;

/** What the Hub's machine has: no Sandbox is given more. Disk null where it is not known. */
export interface HostCapacity {
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly diskBytes: number | null;
}

/** This machine's CPUs and memory, with the size of the Sandboxes' disk. */
export const hostCapacity = (diskBytes: number | null): HostCapacity => ({
  cpus: NodeOS.availableParallelism(),
  memoryBytes: NodeOS.totalmem(),
  diskBytes,
});

/** Why `limits` cannot be set (each value given lies between its floor and the host), if not. */
export const invalidLimitsReason = (
  limits: SandboxLimits,
  host: HostCapacity,
): string | undefined => {
  const { cpus, memoryBytes, pids, diskBytes } = limits;
  if (cpus !== null && !(Number.isFinite(cpus) && cpus >= SANDBOX_LIMIT_FLOORS.cpus)) {
    return `CPUs must be at least ${SANDBOX_LIMIT_FLOORS.cpus}.`;
  }
  if (cpus !== null && cpus > host.cpus) {
    return `CPUs can be at most ${host.cpus}, what the Hub's machine has.`;
  }
  if (memoryBytes !== null && memoryBytes < SANDBOX_LIMIT_FLOORS.memoryBytes) {
    return `Memory must be at least ${formatBytes(SANDBOX_LIMIT_FLOORS.memoryBytes)}.`;
  }
  if (memoryBytes !== null && memoryBytes > host.memoryBytes) {
    return `Memory can be at most ${formatBytes(host.memoryBytes)}, what the Hub's machine has.`;
  }
  if (pids !== null && pids < SANDBOX_LIMIT_FLOORS.pids) {
    return `Processes and threads must be at least ${SANDBOX_LIMIT_FLOORS.pids}.`;
  }
  if (pids !== null && pids > 4_194_304) return "Processes and threads can be at most 4194304.";
  if (diskBytes !== null && diskBytes < SANDBOX_LIMIT_FLOORS.diskBytes) {
    return `Disk must be at least ${formatBytes(SANDBOX_LIMIT_FLOORS.diskBytes)}.`;
  }
  if (diskBytes !== null && host.diskBytes !== null && diskBytes > host.diskBytes) {
    return `Disk can be at most ${formatBytes(host.diskBytes)}, the size of the Hub's disk for Sandboxes.`;
  }
  return undefined;
};

/** Why a Sandbox is stopped for its disk, as its Threads and Settings show it. */
export const diskFullMessage = (usedBytes: number, limitBytes: number) =>
  `Its disk is full: it uses ${formatBytes(usedBytes)} of its ${formatBytes(limitBytes)} limit. The Owner can raise the limit in Settings → Environments → Sandboxes, then start it again.`;

/** Measurements that fail in a row before a Sandbox counts as over its disk limit. */
export const DISK_MEASURE_FAILURES_ALLOWED = 3;

/** Why a Sandbox whose home could not be measured is stopped: it fails closed. */
export const diskUnmeasurableMessage = (reason: string) =>
  `Its disk use could not be measured ${DISK_MEASURE_FAILURES_ALLOWED} times in a row (${reason}), so it counts as over its limit and is stopped. Make every file in its home readable again (or ask the Owner), then start it.`;

/** A home's size, or why it could not be told. `unavailable`: this host has no `du`. */
export type HomeMeasurement =
  | { readonly _tag: "measured"; readonly bytes: number }
  | { readonly _tag: "failed"; readonly reason: string }
  | { readonly _tag: "unavailable" };

const MEASURE_TIMEOUT_MS = 120_000;
const MEASURE_OUTPUT_LIMIT = 64 * 1024;

/**
 * Runs a `du -s -k` (`command` and `args`) and reads its total. Anything but a clean exit with a
 * total is a failure, never a smaller size: an unreadable directory (exit 1), a timeout, too much
 * output. Its stderr is discarded, so nothing the Sandbox names fills the Hub's memory.
 */
export const measureWithDu = (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs = MEASURE_TIMEOUT_MS,
) =>
  Effect.callback<HomeMeasurement>((resume) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: NodeChildProcess.ChildProcess | undefined;
    const settle = (result: HomeMeasurement) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child?.kill("SIGKILL");
      resume(Effect.succeed(result));
    };
    try {
      child = NodeChildProcess.spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      settle({ _tag: "unavailable" });
      return;
    }
    let stdout = "";
    // @effect-diagnostics-next-line globalTimersInEffect:off -- kills the child it started.
    timer = setTimeout(
      () => settle({ _tag: "failed", reason: `it took longer than ${timeoutMs / 1000} s` }),
      timeoutMs,
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MEASURE_OUTPUT_LIMIT) {
        settle({ _tag: "failed", reason: "its output was too large" });
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      settle(
        error.code === "ENOENT"
          ? { _tag: "unavailable" }
          : { _tag: "failed", reason: error.message },
      ),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        return settle({
          _tag: "failed",
          reason: `some of its files could not be read (du exited with code ${code ?? "?"})`,
        });
      }
      const kibibytes = Number.parseInt(stdout.trim().split(/\s/u)[0] ?? "", 10);
      if (!Number.isFinite(kibibytes))
        return settle({ _tag: "failed", reason: "du gave no total" });
      settle({ _tag: "measured", bytes: kibibytes * 1024 });
    });
    return Effect.sync(() => settle({ _tag: "failed", reason: "it was interrupted" }));
  });

/** Free and total bytes of the filesystem a path is on. */
export interface HostSpace {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/** The filesystem `path` is on (the nearest existing parent's); null where it cannot be told. */
export const hostSpaceOf = (path: string): HostSpace | null => {
  let current = path;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const stats = NodeFS.statfsSync(current);
      return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    } catch {
      const parent = NodePath.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
};

/**
 * The least free space the Sandboxes' filesystem keeps, so a Sandbox filling it between checks
 * does not take the Hub's database with it: 5% of the disk, at most 10 GiB.
 */
export const minHostFreeBytes = (totalBytes: number) => Math.min(10 * GIB, totalBytes * 0.05);

/** Why no Sandbox may run on a filesystem this full, if it is. */
export const hostSpaceShortage = (
  space: HostSpace | null,
  minFreeBytes?: number,
): string | undefined => {
  if (space === null) return undefined;
  const floor = minFreeBytes ?? minHostFreeBytes(space.totalBytes);
  if (space.freeBytes >= floor) return undefined;
  return `The Hub's disk for Sandboxes is almost full (${formatBytes(space.freeBytes)} free of ${formatBytes(space.totalBytes)}): no Sandbox runs until at least ${formatBytes(floor)} is free.`;
};
