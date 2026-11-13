import { describe, expect, it } from "vite-plus/test";

import { fileCopyRefusal } from "./fileCopyRefusal";

describe("fileCopyRefusal", () => {
  it("never copies a file read with secrets shown as [NAME]", () => {
    expect(fileCopyRefusal({ truncated: false, masked: true })).toBe(
      "Holds secrets; copy it in a terminal.",
    );
  });

  it("copies a file read whole and unmasked, and refuses one too large", () => {
    expect(fileCopyRefusal({ truncated: false })).toBeNull();
    expect(fileCopyRefusal({ truncated: false, masked: false })).toBeNull();
    expect(fileCopyRefusal({ truncated: true })).toBe("Too large to copy.");
  });
});
