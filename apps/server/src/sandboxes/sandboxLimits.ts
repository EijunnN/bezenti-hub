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

/**
 * Why a Sandbox whose home could not be measured is stopped: it fails closed. Started again, it
 * runs until the checks fail as many times again (`windowSeconds`), its time to repair its files.
 */
export const diskUnmeasurableMessage = (reason: string, windowSeconds: number) =>
  `Its disk use could not be measured ${DISK_MEASURE_FAILURES_ALLOWED} times in a row (${reason}), so it counts as over its limit and was stopped. Start it again to repair its home: within about ${formatDuration(windowSeconds)}, make every file in it readable and remove what makes it slow to measure (such as millions of small files), or it stops again.`;

const formatDuration = (seconds: number) =>
  seconds < 120 ? `${Math.round(seconds)} seconds` : `${Math.round(seconds / 60)} minutes`;

/**
 * The limits a machine can apply: no more CPUs or memory than it has (Podman refuses more CPUs
 * than the machine's), so a limit set for a bigger machine runs at this one's size.
 */
export const fitLimitsToHost = (
  limits: SandboxLimits,
  host: Pick<HostCapacity, "cpus" | "memoryBytes">,
): SandboxLimits => ({
  ...limits,
  cpus: limits.cpus === null ? null : Math.min(limits.cpus, host.cpus),
  memoryBytes: limits.memoryBytes === null ? null : Math.min(limits.memoryBytes, host.memoryBytes),
});

/** A home's size, or why it could not be told. `unavailable`: this host has no `du`. */
export type HomeMeasurement =
  | { readonly _tag: "measured"; readonly bytes: number }
  | { readonly _tag: "failed"; readonly reason: string }
  | { readonly _tag: "unavailable" };

const MEASURE_TIMEOUT_MS = 120_000;
const MEASURE_OUTPUT_LIMIT = 64 * 1024;

/** The longest stderr line read whole; a longer one counts as an error other than a vanished file. */
const MEASURE_LINE_LIMIT = 16 * 1024;
const VANISHED_SUFFIX = ": No such file or directory";

/**
 * Reads `du`'s stderr line by line, keeping no more than one line: whether every one of its own
 * errors (`du: …`) is a file that vanished while it ran (a build's temporary files). GNU `du`
 * quotes a name with a newline, and puts the error after the name, so a name cannot pass for one.
 * Lines that are not `du`'s (a `podman` warning) say nothing of the files.
 */
const duErrorsReader = () => {
  let partial = "";
  let otherErrors = false;
  let vanished = false;
  const line = (text: string) => {
    if (!text.startsWith("du:")) return;
    if (text.endsWith(VANISHED_SUFFIX)) vanished = true;
    else otherErrors = true;
  };
  return {
    chunk: (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const text of lines) line(text);
      if (partial.length > MEASURE_LINE_LIMIT) {
        otherErrors = true;
        partial = "";
      }
    },
    /** Only files that vanished, once the output ended. */
    onlyVanished: () => {
      if (partial !== "") line(partial);
      partial = "";
      return vanished && !otherErrors;
    },
  };
};

/**
 * Runs a `du -s -k` (`command` and `args`) and reads its total. Anything but a clean exit with a
 * total (or exit 1 for vanished files only) is a failure, never a smaller size. It runs in a
 * process group of its own, killed whole when it gives up (`podman unshare` runs `du` in a child).
 */
export const measureWithDu = (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs = MEASURE_TIMEOUT_MS,
) =>
  Effect.callback<HomeMeasurement>((resume) => {
    let settled = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: NodeChildProcess.ChildProcess | undefined;
    const killGroup = () => {
      const pid = child?.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Its group is gone already.
      }
    };
    const settle = (result: HomeMeasurement) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (!closed) killGroup();
      resume(Effect.succeed(result));
    };
    const errors = duErrorsReader();
    try {
      child = NodeChildProcess.spawn(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, to be killed whole; `du`'s errors in words this reads.
        detached: true,
        env: { ...process.env, LC_ALL: "C" },
      });
    } catch {
      settle({ _tag: "unavailable" });
      return;
    }
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", errors.chunk);
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
      // Its output is closed: nothing of its group holds it any more.
      closed = true;
      // Exit 1 with only vanished files is a total of what is there.
      if (code !== 0 && !(code === 1 && errors.onlyVanished())) {
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
 * does not take the Hub's database with it: 5% of the disk, at most 10 GiB. Below it the Sandboxes
 * writing to it stop; below half of it every one does.
 */
export const minHostFreeBytes = (totalBytes: number) => Math.min(10 * GIB, totalBytes * 0.05);

/**
 * What must be free before a Sandbox starts: half as much again as the floor, so a little room
 * freed (a log rotated) does not start them all to be stopped again at once.
 */
const minHostFreeBytesToStart = (totalBytes: number) => minHostFreeBytes(totalBytes) * 1.5;

/** How full the Sandboxes' filesystem is: room, below the floor, or below half of it. */
type HostSpaceLevel = "room" | "low" | "critical";

export const hostSpaceLevel = (space: HostSpace | null): HostSpaceLevel => {
  if (space === null) return "room";
  const floor = minHostFreeBytes(space.totalBytes);
  if (space.freeBytes >= floor) return "room";
  return space.freeBytes < floor / 2 ? "critical" : "low";
};

/**
 * Why a Sandbox may not run (`run`: below the floor) or start (`start`: below the higher start
 * floor) on a filesystem this full, if so. Either way it says how much must be free to start.
 */
export const hostSpaceShortage = (
  space: HostSpace | null,
  kind: "run" | "start",
): string | undefined => {
  if (space === null) return undefined;
  const startFloor = minHostFreeBytesToStart(space.totalBytes);
  const floor = kind === "start" ? startFloor : minHostFreeBytes(space.totalBytes);
  if (space.freeBytes >= floor) return undefined;
  return `The Hub's disk for Sandboxes is almost full (${formatBytes(space.freeBytes)} free of ${formatBytes(space.totalBytes)}): no Sandbox starts until at least ${formatBytes(startFloor)} is free.`;
};
