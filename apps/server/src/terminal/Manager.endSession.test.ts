// @effect-diagnostics nodeBuiltinImport:off -- real bash, real PTY and real /proc: pids, files and a detached process of its own.
/**
 * A shell the Hub closes as stale takes its session's background jobs with it (real bash, real
 * PTY, real /proc). Linux only: elsewhere the machine cannot tell sessions apart.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as HubRunsAgents from "../environment/HubRunsAgents.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as SessionProcesses from "./SessionProcesses.ts";

const facts = { spaceId: "space-acme", userId: "grace" };

/** Alive: present and not a zombie. */
const alive = (pid: number): boolean => {
  try {
    const stat = SessionProcesses.parseProcStat(NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8"));
    return stat !== null && stat.state !== "Z" && stat.state !== "X";
  } catch {
    return false;
  }
};

/** Real processes end on their own schedule: poll /proc until `check` holds. */
const until = (what: string, check: () => boolean) =>
  Effect.promise(() => expect.poll(check, { message: what, timeout: 10_000 }).toBe(true));

const readPid = (file: string) => {
  try {
    const pid = Number(NodeFS.readFileSync(file, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
};

/** Kills only the PIDs this test started (directly or from its shell), once it ends. */
const owned = (pids: Array<number>) =>
  Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }),
  );

const setup = Effect.gen(function* () {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-endsession-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const manager = yield* TerminalManager.makeWithOptions({
    logsDir: NodePath.join(dir, "logs"),
    ptyAdapter,
    shellResolver: () => "/bin/bash",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TERM: "xterm-256color" },
    processKillGraceMs: 200,
    endSessionProcesses: SessionProcesses.endSession,
  });
  const pids: Array<number> = [];
  yield* owned(pids);

  /** A shell in Acme with a background job and a process that left its session. */
  const openShell = Effect.fn("openShell")(function* (terminalId: string) {
    yield* manager.open(
      { threadId: "thread-1", terminalId, cwd: dir, cols: 100, rows: 24 },
      { secrets: undefined, facts },
    );
    const bg = NodePath.join(dir, `${terminalId}.bg`);
    const left = NodePath.join(dir, `${terminalId}.setsid`);
    const shellFile = NodePath.join(dir, `${terminalId}.shell`);
    yield* manager.write({
      threadId: "thread-1",
      terminalId,
      data: `echo $$ > ${shellFile}; ACME_TOKEN=acme sleep 4207 & echo $! > ${bg}\r`,
    });
    yield* manager.write({
      threadId: "thread-1",
      terminalId,
      data: `setsid -f sh -c 'echo $$ > ${left}; exec sleep 4208'\r`,
    });
    yield* until(
      "the shell started its jobs",
      () => readPid(bg) !== null && readPid(left) !== null && readPid(shellFile) !== null,
    );
    const job = readPid(bg)!;
    const setsid = readPid(left)!;
    const shell = readPid(shellFile)!;
    pids.push(job, setsid);
    assert.isTrue(alive(job));
    assert.isTrue(alive(setsid));
    return { job, setsid, shell };
  });

  /** An unrelated process in its own session, started by the test. */
  const unrelated = () => {
    const child = NodeChildProcess.spawn("sleep", ["4209"], { detached: true, stdio: "ignore" });
    child.unref();
    pids.push(child.pid!);
    return child.pid!;
  };

  return { manager, openShell, unrelated, dir };
});

const layer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  ProcessRunner.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  HubRunsAgents.layerRunsAgents,
  NodePtyAdapter.layer.pipe(Layer.provide(NodeServices.layer)),
);

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "a stale-closed shell's session",
  () => {
    it.layer(layer, { excludeTestServices: true })("TerminalManager", (it) => {
      it.effect(
        "a reconcile after a move ends its background job; a setsid process and others stay",
        () =>
          Effect.gen(function* () {
            const { manager, openShell, unrelated } = yield* setup;
            const other = unrelated();
            const { job, setsid } = yield* openShell(DEFAULT_TERMINAL_ID);

            const closed = yield* manager.reconcile({
              threads: [{ threadId: "thread-1", spaceId: "space-globex" }],
              removedUserIds: [],
            });
            assert.equal(closed, 1);

            yield* until("the background job ended", () => !alive(job));
            assert.isTrue(alive(setsid), "a process that left the session is out of scope");
            assert.isTrue(alive(other), "another session is never touched");
          }),
      );

      it.effect("a stale close ends the session; a normal close leaves the job as before", () =>
        Effect.gen(function* () {
          const { manager, openShell } = yield* setup;
          const stale = yield* openShell("stale");
          const normal = yield* openShell("normal");

          yield* manager.close({ threadId: "thread-1", terminalId: "normal" });
          yield* manager.close({
            threadId: "thread-1",
            terminalId: "stale",
            deleteHistory: true,
            endSession: true,
          });

          yield* until("the stale shell's job ended", () => !alive(stale.job));
          assert.isTrue(alive(stale.setsid));
          // Once its shell is gone (SIGTERM, then SIGKILL), its job still runs, as before.
          yield* until("the normal shell ended", () => !alive(normal.shell));
          assert.isTrue(alive(normal.job), "a user's normal close is unchanged");
        }),
      );

      it.effect("a reconcile ends the jobs of a shell that already exited", () =>
        Effect.gen(function* () {
          const { manager, openShell } = yield* setup;
          const { job, shell } = yield* openShell(DEFAULT_TERMINAL_ID);
          const exited = yield* Deferred.make<void>();
          const unsubscribe = yield* manager.subscribe((event) =>
            event.type === "exited" ? Deferred.succeed(exited, undefined) : Effect.void,
          );
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
          yield* manager.write({
            threadId: "thread-1",
            terminalId: DEFAULT_TERMINAL_ID,
            data: "exit\r",
          });
          // The manager saw it exit: its session has no shell process any more.
          yield* Deferred.await(exited);
          assert.isFalse(alive(shell));
          assert.isTrue(alive(job), "its job outlives it in the session");

          const closed = yield* manager.reconcile({
            threads: [{ threadId: "thread-1", spaceId: "space-globex" }],
            removedUserIds: [],
          });
          assert.equal(closed, 1);
          yield* until("the exited shell's job ended", () => !alive(job));
        }),
      );

      it.effect(
        "a restart for another Space ends the old shell's jobs; one for the same stays",
        () =>
          Effect.gen(function* () {
            const { manager, openShell, dir } = yield* setup;
            const elsewhere = NodePath.join(dir, "elsewhere");
            NodeFS.mkdirSync(elsewhere);
            const same = yield* openShell("same");
            const moved = yield* openShell("moved");
            const reopen = (terminalId: string, spaceId: string) =>
              manager.open(
                { threadId: "thread-1", terminalId, cwd: elsewhere, cols: 100, rows: 24 },
                { secrets: undefined, facts: { spaceId, userId: "grace" } },
              );

            yield* reopen("same", "space-acme");
            yield* reopen("moved", "space-globex");

            yield* until("the moved shell's job ended", () => !alive(moved.job));
            yield* until("the same-Space shell was replaced", () => !alive(same.shell));
            assert.isTrue(alive(same.job), "a restart with the same facts and secrets keeps it");
          }),
      );
    });
  },
);
