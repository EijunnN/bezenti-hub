import { describe, expect, it } from "vite-plus/test";

import { copyReadInput, fileCopyRefusal } from "./fileCopyRefusal";

describe("copying ignored files to another machine", () => {
  it("reads each file as it is on disk, never masked", () => {
    expect(copyReadInput("/work/acme", ".env")).toEqual({
      cwd: "/work/acme",
      relativePath: ".env",
      forCopy: true,
    });
  });

  it("copies a file read whole, and refuses one too large", () => {
    expect(fileCopyRefusal({ truncated: false })).toBeNull();
    expect(fileCopyRefusal({ truncated: true })).toBe("Too large to copy.");
  });
});
