// @effect-diagnostics nodeBuiltinImport:off -- checks the processes a measurement leaves.
import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  fitLimitsToHost,
  hostSpaceLevel,
  hostSpaceShortage,
  invalidLimitsReason,
  measureWithDu,
  minHostFreeBytes,
  NO_LIMITS,
} from "./sandboxLimits.ts";

const GIB = 1024 ** 3;
const node = process.execPath;

describe("measuring a Sandbox's home", () => {
  it.effect("reads the total of a clean `du`", () =>
    Effect.gen(function* () {
      const measured = yield* measureWithDu(node, ["-e", "console.log('2048\\t/home')"]);
      assert.deepEqual(measured, { _tag: "measured", bytes: 2048 * 1024 });
    }),
  );

  it.effect("takes a `du` that could not read everything as a failure, not a smaller size", () =>
    Effect.gen(function* () {
      const measured = yield* measureWithDu(node, [
        "-e",
        `console.log('8\\t/home'); console.error("du: cannot read directory '/home/x': Permission denied"); process.exit(1)`,
      ]);
      assert.equal(measured._tag, "failed");
    }),
  );

  it.effect(
    "fails one that takes too long, or prints too much, rather than waiting or growing",
    () =>
      Effect.gen(function* () {
        const slow = yield* measureWithDu(node, ["-e", "setTimeout(() => {}, 60000)"], 300);
        assert.equal(slow._tag, "failed");
        assert.include(slow._tag === "failed" ? slow.reason : "", "longer than");
        const loud = yield* measureWithDu(node, [
          "-e",
          "process.stdout.write('x'.repeat(1024 * 1024)); setTimeout(() => {}, 5000)",
        ]);
        assert.equal(loud._tag, "failed");
      }),
  );

  it.effect("ignores what it prints to stderr, however much", () =>
    Effect.gen(function* () {
      const measured = yield* measureWithDu(node, [
        "-e",
        "process.stderr.write('e'.repeat(4 * 1024 * 1024)); console.log('4\\t/home')",
      ]);
      assert.deepEqual(measured, { _tag: "measured", bytes: 4096 });
    }),
  );

  it.effect(
    "takes files that vanished while it ran as measured, but not one error of any other kind",
    () =>
      Effect.gen(function* () {
        const du = (stderr: ReadonlyArray<string>) =>
          measureWithDu(node, [
            "-e",
            `console.log('16\\t/home'); console.error(${JSON.stringify(stderr.join("\n"))}); process.exit(1)`,
          ]);
        const vanished = "du: cannot access '/home/tmp/a.o': No such file or directory";
        const vanishedDir = "du: cannot read directory '/home/tmp/b': No such file or directory";
        const podmanWarning = 'time="2026-01-01" level=warning msg="no systemd user session"';
        assert.deepEqual(yield* du([vanished, vanishedDir, podmanWarning]), {
          _tag: "measured",
          bytes: 16 * 1024,
        });
        const denied = "du: cannot read directory '/home/hidden': Permission denied";
        assert.equal((yield* du([vanished, denied]))._tag, "failed");
        // A name that names the vanishing error is still the error after it.
        const tricky =
          "du: cannot read directory '/home/x: No such file or directory': Permission denied";
        assert.equal((yield* du([tricky]))._tag, "failed");
        // Many vanished files, beyond any buffer, are still read line by line.
        const many = yield* measureWithDu(node, [
          "-e",
          `for (let i = 0; i < 20000; i++) console.error(${JSON.stringify(vanished)}); console.log("16\t/home"); process.exitCode = 1`,
        ]);
        assert.equal(many._tag, "measured");
        // Exit 1 with no file named is no measurement.
        assert.equal((yield* du([podmanWarning]))._tag, "failed");
      }),
  );

  it.live(
    "kills what the measurement started too, not only its own process, when it gives up",
    () =>
      Effect.gen(function* () {
        // The measurement's child keeps a connection to the test open while it lives.
        const connected = yield* Deferred.make<NodeNet.Socket>();
        const server = NodeNet.createServer((socket) => {
          Deferred.doneUnsafe(connected, Effect.succeed(socket));
        });
        yield* Effect.callback<void>((resume) => {
          server.listen(0, "127.0.0.1", () => resume(Effect.void));
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
        const port = (server.address() as NodeNet.AddressInfo).port;
        const grandchild = `require("node:net").connect(${port}, "127.0.0.1"); setTimeout(() => {}, 60000)`;
        // As `podman unshare du`: the process started runs the measurement in a child of its own.
        const slow = yield* measureWithDu(
          node,
          [
            "-e",
            `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
             setTimeout(() => {}, 60000);`,
          ],
          1_500,
        );
        assert.equal(slow._tag, "failed");
        const socket = yield* Deferred.await(connected);
        // Its child ended with it: its connection closes.
        const closed = yield* Effect.callback<void>((resume) => {
          if (socket.destroyed) return resume(Effect.void);
          socket.on("close", () => resume(Effect.void));
          socket.resume();
        }).pipe(Effect.timeoutOption("5 seconds"));
        socket.destroy();
        assert.isTrue(Option.isSome(closed), "the measurement's child outlived it");
      }).pipe(Effect.scoped),
  );

  it.effect("says when the host has no `du` at all", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* measureWithDu("t3-no-such-du-here", ["-s"]), {
        _tag: "unavailable",
      });
    }),
  );
});

describe("which limits a Sandbox may have", () => {
  const host = { cpus: 8, memoryBytes: 16 * GIB, diskBytes: 500 * GIB };
  it("refuses each value below its floor or above the Hub's machine, saying which", () => {
    for (const [limits, why] of [
      [{ ...NO_LIMITS, cpus: 0.05 }, "at least 0.1"],
      [{ ...NO_LIMITS, cpus: 9 }, "at most 8"],
      [{ ...NO_LIMITS, memoryBytes: 255 * 1024 ** 2 }, "at least 256 MiB"],
      [{ ...NO_LIMITS, memoryBytes: 17 * GIB }, "at most 16 GiB"],
      [{ ...NO_LIMITS, pids: 63 }, "at least 64"],
      [{ ...NO_LIMITS, diskBytes: GIB - 1 }, "at least 1.0 GiB"],
      [{ ...NO_LIMITS, diskBytes: 501 * GIB }, "at most 500 GiB"],
    ] as const) {
      assert.include(invalidLimitsReason(limits, host) ?? "", why, JSON.stringify(limits));
    }
  });
  it("takes the floors, the host's own size, and no limit", () => {
    assert.isUndefined(
      invalidLimitsReason(
        { cpus: 0.1, memoryBytes: 256 * 1024 ** 2, pids: 64, diskBytes: GIB },
        host,
      ),
    );
    assert.isUndefined(
      invalidLimitsReason(
        { cpus: 8, memoryBytes: 16 * GIB, pids: 4096, diskBytes: 500 * GIB },
        host,
      ),
    );
    assert.isUndefined(invalidLimitsReason(NO_LIMITS, { ...host, diskBytes: null }));
  });
});

describe("the Hub's disk for Sandboxes", () => {
  it("keeps 5% free, at most 10 GiB", () => {
    assert.equal(minHostFreeBytes(100 * GIB), 5 * GIB);
    assert.equal(minHostFreeBytes(2000 * GIB), 10 * GIB);
  });
  it("is short below that floor, and says how much must be free to start again", () => {
    assert.isUndefined(hostSpaceShortage({ freeBytes: 6 * GIB, totalBytes: 100 * GIB }, "run"));
    assert.include(
      hostSpaceShortage({ freeBytes: 4 * GIB, totalBytes: 100 * GIB }, "run") ?? "",
      "4.0 GiB free of 100 GiB",
    );
    assert.include(
      hostSpaceShortage({ freeBytes: 9 * GIB, totalBytes: 2000 * GIB }, "run") ?? "",
      "until at least 15 GiB",
    );
    // Unknown: nothing is refused for it.
    assert.isUndefined(hostSpaceShortage(null, "start"));
  });
  it("starts nothing until half as much again is free, so a little room does not restart them all", () => {
    const space = { freeBytes: 11 * GIB, totalBytes: 2000 * GIB };
    assert.isUndefined(hostSpaceShortage(space, "run"));
    assert.include(hostSpaceShortage(space, "start") ?? "", "at least 15 GiB");
    assert.isUndefined(hostSpaceShortage({ ...space, freeBytes: 15 * GIB }, "start"));
  });
  it("is low below the floor and critical below half of it", () => {
    const total = 2000 * GIB;
    assert.equal(hostSpaceLevel({ freeBytes: 10 * GIB, totalBytes: total }), "room");
    assert.equal(hostSpaceLevel({ freeBytes: 9 * GIB, totalBytes: total }), "low");
    assert.equal(hostSpaceLevel({ freeBytes: 4 * GIB, totalBytes: total }), "critical");
    assert.equal(hostSpaceLevel(null), "room");
  });
});

describe("a machine's own size", () => {
  it("caps CPUs and memory at what it has, and leaves the rest", () => {
    const host = { cpus: 1, memoryBytes: 2 * GIB };
    assert.deepEqual(
      fitLimitsToHost({ cpus: 2, memoryBytes: 4 * GIB, pids: 4096, diskBytes: 20 * GIB }, host),
      { cpus: 1, memoryBytes: 2 * GIB, pids: 4096, diskBytes: 20 * GIB },
    );
    assert.deepEqual(fitLimitsToHost(NO_LIMITS, host), NO_LIMITS);
    assert.deepEqual(fitLimitsToHost({ ...NO_LIMITS, cpus: 0.5 }, host), {
      ...NO_LIMITS,
      cpus: 0.5,
    });
  });
});
