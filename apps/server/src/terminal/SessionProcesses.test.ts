// @effect-diagnostics nodeBuiltinImport:off -- a fake procRoot on disk, read as /proc would be.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  endSessionWith,
  parseRealUid,
  procSource,
  parseProcStat,
  type ProcSource,
  type SessionSignal,
  sessionGroups,
} from "./SessionProcesses.ts";

const stat = (pid: number, comm: string, state: string, pgrp: number, session: number) =>
  `${pid} (${comm}) ${state} 1 ${pgrp} ${session} 34816 ${pgrp} 4194560 0 0 0 0 0 0 20 0 1 0\n`;

interface FakeProc {
  readonly pid: number;
  comm: string;
  state: string;
  pgrp: number;
  session: number;
  uid: number;
}

const fakeSource = (procs: Array<FakeProc>): ProcSource => ({
  pids: () => procs.map((proc) => proc.pid),
  stat: (pid) => {
    const proc = procs.find((candidate) => candidate.pid === pid);
    return proc === undefined
      ? undefined
      : stat(proc.pid, proc.comm, proc.state, proc.pgrp, proc.session);
  },
  uid: (pid) => procs.find((candidate) => candidate.pid === pid)?.uid,
});

it("reads a stat whose comm holds spaces, ')' and a newline, after the last ')'", () => {
  assert.deepStrictEqual(parseProcStat(stat(4207, "a) b\n(c) 9 9 9", "S", 4200, 4100)), {
    pid: 4207,
    state: "S",
    ppid: 1,
    pgrp: 4200,
    session: 4100,
  });
  assert.deepStrictEqual(parseProcStat(stat(12, "sleep", "R", 12, 10))?.session, 10);
});

it("refuses a stat it cannot read", () => {
  assert.isNull(parseProcStat(""));
  assert.isNull(parseProcStat("12 sleep S 1 12 10"));
  assert.isNull(parseProcStat("12 (sleep)"));
  assert.isNull(parseProcStat("x (sleep) S 1 12 10"));
  assert.isNull(parseProcStat("12 (sleep) S 1 -12 10"));
});

it("finds the session's live groups of the same uid only", () => {
  const source = fakeSource([
    { pid: 100, comm: "bash", state: "S", pgrp: 100, session: 100, uid: 1000 },
    { pid: 101, comm: "sleep", state: "S", pgrp: 101, session: 100, uid: 1000 },
    { pid: 102, comm: "sleep", state: "S", pgrp: 101, session: 100, uid: 1000 },
    { pid: 103, comm: "npm run dev", state: "S", pgrp: 103, session: 100, uid: 1000 },
    // Left the session (setsid): out of scope.
    { pid: 104, comm: "daemon", state: "S", pgrp: 104, session: 104, uid: 1000 },
    // Another User's process in a session with that id cannot be ours.
    { pid: 105, comm: "sleep", state: "S", pgrp: 105, session: 100, uid: 1001 },
    // A zombie is already gone.
    { pid: 106, comm: "sleep", state: "Z", pgrp: 106, session: 100, uid: 1000 },
    // Another shell's session.
    { pid: 200, comm: "bash", state: "S", pgrp: 200, session: 200, uid: 1000 },
  ]);
  const { ours, mixed } = sessionGroups(source, 100, 1000);
  assert.deepStrictEqual([...ours].toSorted(), [100, 101, 103]);
  assert.deepStrictEqual([...mixed], [105]);
});

it.live("re-reads the session before each signal and stops once it is empty", () =>
  Effect.gen(function* () {
    const procs: Array<FakeProc> = [
      { pid: 101, comm: "sleep", state: "S", pgrp: 101, session: 100, uid: 1000 },
      { pid: 103, comm: "trap-hup", state: "S", pgrp: 103, session: 100, uid: 1000 },
    ];
    const sent: Array<[number, SessionSignal]> = [];
    yield* endSessionWith(100, {
      source: fakeSource(procs),
      uid: 1000,
      graceMs: 1,
      protectedSessions: new Set(),
      killGroup: (pgrp, signal) => {
        sent.push([pgrp, signal]);
        if (pgrp === 101)
          procs.splice(
            procs.findIndex((proc) => proc.pid === 101),
            1,
          );
        // 103 ignores SIGHUP, then leaves the session (setsid) before SIGTERM reaches it.
        if (pgrp === 103 && signal === "SIGHUP") {
          const proc = procs.find((candidate) => candidate.pid === 103)!;
          proc.session = 103;
          proc.pgrp = 103;
        }
      },
    });
    assert.deepStrictEqual(sent, [
      [101, "SIGHUP"],
      [103, "SIGHUP"],
    ]);
  }),
);

it.live("escalates to SIGKILL for a group that ignores the rest", () =>
  Effect.gen(function* () {
    const procs: Array<FakeProc> = [
      { pid: 103, comm: "stubborn", state: "S", pgrp: 103, session: 100, uid: 1000 },
    ];
    const sent: Array<SessionSignal> = [];
    yield* endSessionWith(100, {
      source: fakeSource(procs),
      uid: 1000,
      graceMs: 1,
      protectedSessions: new Set(),
      killGroup: (_pgrp, signal) => {
        sent.push(signal);
        if (signal === "SIGKILL") procs.length = 0;
      },
    });
    assert.deepStrictEqual(sent, ["SIGHUP", "SIGTERM", "SIGKILL"]);
  }),
);

it.live("never ends this process's own session", () =>
  Effect.gen(function* () {
    const sent: Array<number> = [];
    yield* endSessionWith(100, {
      source: fakeSource([
        { pid: 101, comm: "node", state: "S", pgrp: 101, session: 100, uid: 1000 },
      ]),
      uid: 1000,
      graceMs: 1,
      protectedSessions: new Set([100]),
      killGroup: (pgrp) => sent.push(pgrp),
    });
    assert.deepStrictEqual(sent, []);
  }),
);

it.live("never signals a group with a member of another uid (a machine running as root)", () =>
  Effect.gen(function* () {
    const sent: Array<number> = [];
    yield* endSessionWith(100, {
      source: fakeSource([
        { pid: 101, comm: "sleep", state: "S", pgrp: 101, session: 100, uid: 0 },
        { pid: 102, comm: "su", state: "S", pgrp: 101, session: 100, uid: 1001 },
        { pid: 103, comm: "sleep", state: "S", pgrp: 103, session: 100, uid: 0 },
      ]),
      uid: 0,
      graceMs: 1,
      protectedSessions: new Set(),
      killGroup: (pgrp) => sent.push(pgrp),
    });
    assert.deepStrictEqual([...new Set(sent)], [103]);
  }),
);

it("reads the real uid from status, not the owner of /proc/<pid>", () => {
  assert.equal(parseRealUid("Name:\tssh\nUid:\t1000\t0\t0\t0\nGid:\t1000\n"), 1000);
  assert.equal(parseRealUid("Uid:\t0\t0\t0\t0\n"), 0);
  assert.isNull(parseRealUid("Name:\tssh\n"));

  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-proc-"));
  try {
    const ours = NodeFS.statSync(root).uid;
    const write = (pid: number, uid: number) => {
      NodeFS.mkdirSync(NodePath.join(root, String(pid)));
      NodeFS.writeFileSync(
        NodePath.join(root, String(pid), "stat"),
        stat(pid, "ssh", "S", pid, 100),
      );
      NodeFS.writeFileSync(NodePath.join(root, String(pid), "status"), `Uid:\t${uid}\t0\t0\t0\n`);
    };
    // Both directories are owned by this test's uid; only the status says whose they are.
    write(101, ours);
    write(102, ours + 1);
    const { ours: groups, mixed } = sessionGroups(procSource(root), 100, ours);
    assert.deepStrictEqual([...groups], [101]);
    assert.deepStrictEqual([...mixed], [102]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
