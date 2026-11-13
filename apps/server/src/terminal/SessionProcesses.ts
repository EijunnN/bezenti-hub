/**
 * Ends a stale-closed shell's session: its pid is the session id of every job it started. Signals
 * the session's process groups (HUP, TERM, KILL), re-reading `/proc` before each signal; a group
 * never spans sessions. Linux only; elsewhere nothing is signalled. See docs/internals/secrets.md.
 */
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export interface ProcStat {
  readonly pid: number;
  readonly state: string;
  readonly ppid: number;
  readonly pgrp: number;
  readonly session: number;
}

const positiveInt = (text: string | undefined): number | null => {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

/**
 * `/proc/<pid>/stat`: `pid (comm) state ppid pgrp session ...`. comm may hold spaces, parens and
 * newlines, so the fields are read after the LAST `)`.
 */
export const parseProcStat = (text: string): ProcStat | null => {
  const open = text.indexOf(" (");
  const close = text.lastIndexOf(")");
  if (open <= 0 || close < open) return null;
  const pid = positiveInt(text.slice(0, open));
  const [state, ppid, pgrp, session] = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const parsed = {
    ppid: positiveInt(ppid),
    pgrp: positiveInt(pgrp),
    session: positiveInt(session),
  };
  if (
    pid === null ||
    state === undefined ||
    !/^[A-Za-z]$/.test(state) ||
    parsed.ppid === null ||
    parsed.pgrp === null ||
    parsed.session === null
  ) {
    return null;
  }
  return { pid, state, ppid: parsed.ppid, pgrp: parsed.pgrp, session: parsed.session };
};

/** Where processes are read from: `/proc` on Linux, a fake in tests. */
export interface ProcSource {
  readonly pids: () => ReadonlyArray<number>;
  /** The stat text, or undefined once the process is gone. */
  readonly stat: (pid: number) => string | undefined;
  /** The uid owning the process, or undefined once it is gone. */
  readonly ownerUid: (pid: number) => number | undefined;
}

const procSource = (procRoot = "/proc"): ProcSource => ({
  pids: () => {
    try {
      return NodeFS.readdirSync(procRoot).flatMap((name) => {
        const pid = positiveInt(name);
        return pid === null ? [] : [pid];
      });
    } catch {
      return [];
    }
  },
  stat: (pid) => {
    try {
      return NodeFS.readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    } catch {
      return undefined;
    }
  },
  ownerUid: (pid) => {
    try {
      return NodeFS.statSync(`${procRoot}/${pid}`).uid;
    } catch {
      return undefined;
    }
  },
});

/** The process groups with a live member in session `sid` owned by `uid`, read now. */
export const sessionGroups = (
  source: ProcSource,
  sid: number,
  uid: number,
): ReadonlySet<number> => {
  const groups = new Set<number>();
  for (const pid of source.pids()) {
    const text = source.stat(pid);
    const stat = text === undefined ? null : parseProcStat(text);
    if (stat === null || stat.session !== sid) continue;
    if (stat.state === "Z" || stat.state === "X") continue;
    if (source.ownerUid(pid) !== uid) continue;
    groups.add(stat.pgrp);
  }
  return groups;
};

export type SessionSignal = "SIGHUP" | "SIGTERM" | "SIGKILL";
const SIGNALS: ReadonlyArray<SessionSignal> = ["SIGHUP", "SIGTERM", "SIGKILL"];

export interface EndSessionOptions {
  readonly source: ProcSource;
  readonly uid: number;
  readonly graceMs: number;
  /** Signals a whole process group (`kill(-pgrp, signal)`). */
  readonly killGroup: (pgrp: number, signal: SessionSignal) => void;
  /** Sessions never ended: this process's own, whatever the caller passes. */
  readonly protectedSessions: ReadonlySet<number>;
}

/**
 * Ends session `sid`: each signal goes to the groups found in that session just before it, and
 * the next step waits `graceMs`. Stops as soon as nothing is left. Answers the groups signalled.
 */
export const endSessionWith = Effect.fn("SessionProcesses.endSession")(function* (
  sid: number,
  options: EndSessionOptions,
) {
  const signalled = new Set<number>();
  if (!Number.isSafeInteger(sid) || sid <= 1 || options.protectedSessions.has(sid)) {
    return signalled;
  }
  for (const [index, signal] of SIGNALS.entries()) {
    if (index > 0) yield* Effect.sleep(Duration.millis(options.graceMs));
    const groups = sessionGroups(options.source, sid, options.uid);
    if (groups.size === 0) break;
    for (const pgrp of groups) {
      if (pgrp <= 1) continue;
      try {
        options.killGroup(pgrp, signal);
        signalled.add(pgrp);
      } catch {
        // Gone already (ESRCH) or not ours (EPERM): nothing to end.
      }
    }
  }
  return signalled;
});

const ownSession = (source: ProcSource): ReadonlySet<number> => {
  const text = source.stat(NodeProcess.pid);
  const stat = text === undefined ? null : parseProcStat(text);
  return new Set(stat === null ? [] : [stat.session, stat.pgrp]);
};

/**
 * The machine's way to end a closed shell's session: Linux reads `/proc`; any other platform
 * (macOS, Windows) cannot tell sessions apart and ends nothing.
 */
export const endSession = (sid: number, graceMs: number): Effect.Effect<void> => {
  const uid = NodeProcess.getuid?.();
  if (NodeProcess.platform !== "linux" || uid === undefined) return Effect.void;
  const source = procSource();
  const protectedSessions = ownSession(source);
  // Fails closed: without our own session read, nothing is signalled.
  if (protectedSessions.size === 0) return Effect.void;
  return endSessionWith(sid, {
    source,
    uid,
    graceMs,
    protectedSessions,
    killGroup: (pgrp, signal) => NodeProcess.kill(-pgrp, signal),
  }).pipe(Effect.asVoid);
};
