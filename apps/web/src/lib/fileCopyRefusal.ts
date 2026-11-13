import type { ProjectReadFileInput, ProjectReadFileResult } from "@t3tools/contracts";

/**
 * The read of a file to copy to another machine: as it is on disk (spec 5: a copy read is never
 * masked, so an `.env` arrives with its values, not `[NAME]`).
 */
export function copyReadInput(cwd: string, relativePath: string): ProjectReadFileInput {
  return { cwd, relativePath, forCopy: true };
}

/** Why a file read to be copied to another machine is not copied, or null to copy it. */
export function fileCopyRefusal(read: Pick<ProjectReadFileResult, "truncated">): string | null {
  return read.truncated ? "Too large to copy." : null;
}
