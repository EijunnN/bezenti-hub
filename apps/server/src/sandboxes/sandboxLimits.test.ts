import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
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
        "console.log('8\\t/home'); console.error('cannot read'); process.exit(1)",
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
  it("is short below that floor, and says how much is free", () => {
    assert.isUndefined(hostSpaceShortage({ freeBytes: 6 * GIB, totalBytes: 100 * GIB }));
    assert.include(
      hostSpaceShortage({ freeBytes: 4 * GIB, totalBytes: 100 * GIB }) ?? "",
      "4.0 GiB free of 100 GiB",
    );
    assert.include(
      hostSpaceShortage({ freeBytes: 9 * GIB, totalBytes: 2000 * GIB }) ?? "",
      "at least 10 GiB",
    );
    // Unknown: nothing is refused for it.
    assert.isUndefined(hostSpaceShortage(null));
  });
});
