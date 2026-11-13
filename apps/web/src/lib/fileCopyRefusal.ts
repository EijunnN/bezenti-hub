import type { ProjectReadFileResult } from "@t3tools/contracts";

/**
 * Why a file read to be copied to another machine is not copied, or null to copy it. A read that
 * shows a secret as `[NAME]` (spec 5) would write `[NAME]` in its place there.
 */
export function fileCopyRefusal(
  read: Pick<ProjectReadFileResult, "truncated" | "masked">,
): string | null {
  if (read.truncated) return "Too large to copy.";
  if (read.masked === true) return "Holds secrets; copy it in a terminal.";
  return null;
}
