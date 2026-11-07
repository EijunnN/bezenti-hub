import { describe, expect, it } from "vite-plus/test";

import { joinModeRefusal } from "./joinMode.ts";

describe("the mode `t3 join` takes", () => {
  const approverLabel = "Ada (ada)";
  it("is the one the machine asked for", () => {
    expect(joinModeRefusal({ asked: undefined, dedicatedTo: undefined, approverLabel })).toBe(
      undefined,
    );
    expect(joinModeRefusal({ asked: "Acme", dedicatedTo: "Acme", approverLabel })).toBe(undefined);
  });
  it("refuses a personal approval of a machine that asked to be dedicated", () => {
    expect(joinModeRefusal({ asked: "Acme", dedicatedTo: undefined, approverLabel })).toMatch(
      /approved it as their personal machine, not as one dedicated to Acme/,
    );
  });
  it("refuses a dedicated approval of a machine that did not ask for it", () => {
    expect(joinModeRefusal({ asked: undefined, dedicatedTo: "Acme", approverLabel })).toMatch(
      /dedicated to Acme, but this machine did not ask/,
    );
  });
});
