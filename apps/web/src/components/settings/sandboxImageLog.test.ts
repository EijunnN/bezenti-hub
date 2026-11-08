import { describe, expect, it } from "vite-plus/test";

import { receiveBuildLog } from "./sandboxImageLog";

const STARTED = "2026-11-07T10:00:00.000Z";
const build = (lines: ReadonlyArray<string>, logLines: number, startedAt = STARTED) => ({
  startedAt,
  log: lines,
  logLines,
});

describe("receiveBuildLog", () => {
  it("appends only the lines after the shown ones", () => {
    const first = receiveBuildLog({
      shown: null,
      log: [],
      build: build(["a", "b"], 2),
      askedAfter: undefined,
      keep: 40,
    });
    expect(first.log).toEqual(["a", "b"]);
    const next = receiveBuildLog({
      ...first,
      build: build(["c"], 3),
      askedAfter: 2,
      keep: 40,
    });
    expect(next.log).toEqual(["a", "b", "c"]);
    expect(next.shown).toEqual({ startedAt: STARTED, lines: 3 });
  });

  it("shows each line once when two polls asked for the same lines", () => {
    const shown = { startedAt: STARTED, lines: 2 };
    // Both polls asked `after=2` before either answered.
    const one = receiveBuildLog({
      shown,
      log: ["a", "b"],
      build: build(["c", "d"], 4),
      askedAfter: 2,
      keep: 40,
    });
    const two = receiveBuildLog({
      ...one,
      build: build(["c", "d", "e"], 5),
      askedAfter: 2,
      keep: 40,
    });
    expect(two.log).toEqual(["a", "b", "c", "d", "e"]);
    // A late answer older than what is shown changes nothing.
    const late = receiveBuildLog({ ...two, build: build(["c"], 3), askedAfter: 2, keep: 40 });
    expect(late.log).toEqual(["a", "b", "c", "d", "e"]);
    expect(late.shown).toEqual({ startedAt: STARTED, lines: 5 });
  });

  it("starts over for another build, and keeps only the newest lines", () => {
    const other = receiveBuildLog({
      shown: { startedAt: STARTED, lines: 2 },
      log: ["a", "b"],
      build: build(["x", "y", "z"], 3, "2026-11-07T11:00:00.000Z"),
      askedAfter: undefined,
      keep: 2,
    });
    expect(other.log).toEqual(["y", "z"]);
    // Asked relative to the old build: shown, but the whole of the new one is asked next.
    const relative = receiveBuildLog({
      shown: { startedAt: STARTED, lines: 2 },
      log: ["a", "b"],
      build: build(["z"], 3, "2026-11-07T11:00:00.000Z"),
      askedAfter: 2,
      keep: 40,
    });
    expect(relative.shown).toBeNull();
  });
});
