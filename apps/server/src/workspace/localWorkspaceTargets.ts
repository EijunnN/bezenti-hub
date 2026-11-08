/**
 * What a workspace call on the Hub's own disk opens, for a caller whose access is checked. Its
 * rules (absolute folders, no `~` or `..`, a browse path absolute or `./`-relative) make the
 * handlers' own resolution (`path.resolve`, `WorkspaceEntries.resolveBrowseTarget`) the identity.
 */
import { WS_METHODS } from "@t3tools/contracts";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@t3tools/shared/path";
import * as Predicate from "effect/Predicate";

const isAbsoluteWorkspacePath = (value: string) =>
  value.startsWith("/") || value.startsWith("\\") || isWindowsAbsolutePath(value);

const hasParentSegment = (value: string) => value.split(/[\\/]/u).includes("..");

const field = (payload: unknown, name: string): string | undefined => {
  const value = Predicate.isObject(payload)
    ? (payload as Record<string, unknown>)[name]
    : undefined;
  return typeof value === "string" ? value.trim() : undefined;
};

const joinUnder = (base: string, relative: string) =>
  `${base.replace(/[\\/]+$/u, "")}/${relative.replace(/^\.[\\/]/u, "")}`;

/** The paths the call opens, each to be checked against the caller's roots; "refused" otherwise. */
export const localWorkspaceTargets = (
  method: string,
  payload: unknown,
): ReadonlyArray<string> | "refused" => {
  const cwd = field(payload, "cwd");
  const named = ["cwd", "relativePath", "directoryPath", "partialPath"].map((name) =>
    field(payload, name),
  );
  if (
    named.some((value) => value !== undefined && (value.startsWith("~") || hasParentSegment(value)))
  ) {
    return "refused";
  }
  if (cwd !== undefined && !isAbsoluteWorkspacePath(cwd)) return "refused";
  if (method === WS_METHODS.filesystemBrowse) {
    const partial = field(payload, "partialPath") ?? "";
    // A path neither absolute nor explicitly relative resolves against the server's own cwd.
    const full = isAbsoluteWorkspacePath(partial)
      ? partial
      : isExplicitRelativePath(partial) && cwd !== undefined
        ? joinUnder(cwd, partial)
        : undefined;
    if (full === undefined) return "refused";
    // The folder it lists: the path itself when it ends in a separator, else its parent.
    const cut = Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\"));
    return [/[\\/]$/u.test(full) || cut < 0 ? full : full.slice(0, cut + 1)];
  }
  const targets: Array<string> = cwd === undefined ? [] : [cwd];
  for (const name of ["relativePath", "directoryPath"]) {
    const value = field(payload, name);
    if (value === undefined || value === "") continue;
    if (isAbsoluteWorkspacePath(value)) targets.push(value);
    else if (cwd !== undefined) targets.push(joinUnder(cwd, value));
  }
  return targets;
};
