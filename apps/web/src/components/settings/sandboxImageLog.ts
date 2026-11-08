import type { SandboxImageBuild } from "@t3tools/contracts";

/** The build the shown lines are of, and how many lines it had printed when they were taken. */
export interface ShownBuildLog {
  readonly startedAt: string | null;
  readonly lines: number;
}

/**
 * The build output to show once a status comes in, asked with `askedAfter` (the lines shown when
 * it was asked; none for the whole log). Only lines newer than the shown ones are appended, so a
 * response that arrives late or twice (polls that overlap on a slow link) adds nothing again.
 */
export function receiveBuildLog(input: {
  readonly shown: ShownBuildLog | null;
  readonly log: ReadonlyArray<string>;
  readonly build: Pick<SandboxImageBuild, "startedAt" | "log" | "logLines">;
  readonly askedAfter: number | undefined;
  readonly keep: number;
}): { readonly shown: ShownBuildLog | null; readonly log: ReadonlyArray<string> } {
  const { shown, build, askedAfter, keep } = input;
  const same = shown !== null && shown.startedAt === build.startedAt;
  if (same && askedAfter !== undefined) {
    const fresh = build.logLines - shown.lines;
    if (fresh <= 0) return { shown, log: input.log };
    return {
      shown: { startedAt: build.startedAt, lines: build.logLines },
      log: [...input.log, ...build.log.slice(-fresh)].slice(-keep),
    };
  }
  return {
    log: build.log.slice(-keep),
    // Lines asked for relative to another build are not these: ask for all of this one next.
    shown: askedAfter === undefined ? { startedAt: build.startedAt, lines: build.logLines } : null,
  };
}
