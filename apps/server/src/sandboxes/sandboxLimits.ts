// @effect-diagnostics nodeBuiltinImport:off -- measures a Sandbox's home with `du`.
/**
 * A Sandbox's limits: the Installation's defaults, a Space's override over them, and the disk
 * check the Hub runs itself (a home is a plain directory, so no runtime limits its size). Pure but
 * for `homeUsageBytes`. See docs/internals/sandboxes.md#limits.
 */
import * as NodeChildProcess from "node:child_process";

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

const gib = (bytes: number) => {
  const value = bytes / 1024 ** 3;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} GiB`;
};

/** Why a Sandbox is stopped for its disk, as its Threads and Settings show it. */
export const diskFullMessage = (usedBytes: number, limitBytes: number) =>
  `Its disk is full: it uses ${gib(usedBytes)} of its ${gib(limitBytes)} limit. The Owner can raise the limit in Settings → Environments → Sandboxes, then start it again.`;

/**
 * The size of a Sandbox's home in bytes (`du`, staying on its filesystem, links not followed), or
 * null where it cannot be measured (no `du`, as on Windows).
 */
export const homeUsageBytes = (homePath: string) =>
  Effect.callback<number | null>((resume) => {
    const child = NodeChildProcess.execFile(
      "du",
      ["-s", "-k", "-x", homePath],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        // `du` exits 1 when it could not read some file (one the Sandbox made unreadable): what it
        // could read still counts.
        const kibibytes = Number.parseInt(stdout.trim().split(/\s/u)[0] ?? "", 10);
        if (Number.isFinite(kibibytes)) return resume(Effect.succeed(kibibytes * 1024));
        resume(
          Effect.logDebug("Could not measure a Sandbox's home", {
            homePath,
            cause: error?.message ?? "no output",
          }).pipe(Effect.as(null)),
        );
      },
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });
