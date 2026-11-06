/**
 * Where a Thread works, independent of any one machine: a path inside its Project's checkout, or,
 * for a path outside it (a managed worktree, an unrelated folder), the absolute path on the one
 * Environment it was recorded on (`docs/internals/overview.md`, «Logical workspace paths»).
 */
import { EnvironmentId, HUB_MACHINE_ENVIRONMENT_ID, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const WorkspaceLocation = Schema.Union([
  /** `path` is `/`-separated, relative to the checkout, `.` for the checkout itself. */
  Schema.Struct({ base: Schema.Literal("checkout"), path: Schema.String }),
  /** Only the Environment it was recorded on can resolve it. */
  Schema.Struct({
    base: Schema.Literal("host"),
    environmentId: EnvironmentId,
    path: Schema.String,
  }),
]);
export type WorkspaceLocation = typeof WorkspaceLocation.Type;

const WorkspaceLocationJson = Schema.fromJsonString(WorkspaceLocation);
const encodeWorkspaceLocationJson = Schema.encodeSync(WorkspaceLocationJson);
export const decodeWorkspaceLocationJson = Schema.decodeUnknownSync(WorkspaceLocationJson);
export const decodeWorkspaceLocationJsonEffect = Schema.decodeUnknownEffect(WorkspaceLocationJson);

export class WorkspaceLocationUnavailableError extends Schema.TaggedError<WorkspaceLocationUnavailableError>()(
  "WorkspaceLocationUnavailableError",
  {
    environmentId: EnvironmentId,
    projectId: ProjectId,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Environment ${this.environmentId} cannot resolve a workspace of project ${this.projectId}: ${this.reason}`;
  }
}

const SEPARATORS = /[\\/]/;

// Lexical on purpose: the checkout and the path may belong to another machine's platform.
const isSeparator = (character: string | undefined) => character === "/" || character === "\\";

/** Drops trailing separators, keeping a filesystem root (`/`, `C:\`) whole. */
const trimTrailingSeparators = (root: string): string => {
  let end = root.length;
  while (end > 1 && isSeparator(root[end - 1])) end -= 1;
  return end === 2 && root[1] === ":" && isSeparator(root[2])
    ? root.slice(0, 3)
    : root.slice(0, end);
};

/** The separator a root already uses, so a joined path looks native to its machine. */
const separatorOf = (root: string): "/" | "\\" =>
  root.includes("\\") || /^[A-Za-z]:$/.test(root) ? "\\" : "/";

/**
 * The logical form of `absolute`, recorded on `environmentId` where the Project's checkout is
 * `checkout`. A path that is not plainly inside the checkout stays absolute and host-bound.
 */
export function locateInCheckout(input: {
  readonly environmentId: EnvironmentId;
  readonly checkout: string | null;
  readonly absolute: string;
}): WorkspaceLocation {
  const host = {
    base: "host",
    environmentId: input.environmentId,
    path: input.absolute,
  } as const;
  if (input.checkout === null || input.checkout === "") return host;
  const root = trimTrailingSeparators(input.checkout);
  if (input.absolute === root) return { base: "checkout", path: "." };
  const prefixes = isSeparator(root.at(-1)) ? [root] : [`${root}/`, `${root}\\`];
  const prefix = prefixes.find((candidate) => input.absolute.startsWith(candidate));
  if (prefix === undefined) return host;
  const segments = input.absolute.slice(prefix.length).split(SEPARATORS);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return host;
  }
  const relative = segments.join("/");
  // Only a form that resolves back to the same string on this machine; anything else stays exact.
  return joinUnderRoot(input.checkout, relative) === input.absolute
    ? { base: "checkout", path: relative }
    : host;
}

/**
 * The stored form of a path the projection records today: every recorded path comes from the Hub
 * machine, whose checkout of a Project is the Project's workspace root. Null while that checkout is
 * unknown (the Thread or Project row is not projected yet), so no row freezes as host-bound by
 * accident; readers compute the form then.
 */
export function hubMachineLocationJson(checkout: string | null, absolute: string): string | null {
  return checkout === null
    ? null
    : encodeWorkspaceLocationJson(
        locateInCheckout({ environmentId: HUB_MACHINE_ENVIRONMENT_ID, checkout, absolute }),
      );
}

/** Whether a stored form is relative to the checkout, so every machine resolves it in its own. */
export function isCheckoutRelativeJson(json: string | null): boolean {
  if (json === null) return false;
  try {
    return decodeWorkspaceLocationJson(json).base === "checkout";
  } catch {
    return false;
  }
}

/** The stored form of an absolute path only `environmentId` can resolve. */
export function hostLocationJson(environmentId: EnvironmentId, absolute: string): string {
  return encodeWorkspaceLocationJson({ base: "host", environmentId, path: absolute });
}

/** Joins `/`-separated segments onto a root in that root's own separator style. */
export function joinUnderRoot(root: string, relative: string): string {
  if (relative === ".") return trimTrailingSeparators(root);
  const trimmed = trimTrailingSeparators(root);
  const separator = separatorOf(trimmed);
  const joined = relative.split("/").join(separator);
  return trimmed.endsWith(separator) ? `${trimmed}${joined}` : `${trimmed}${separator}${joined}`;
}

/** The absolute path of a location on one Environment, given that Environment's checkout. */
export function resolveOnEnvironment(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly checkout: string | null;
  readonly location: WorkspaceLocation;
}): string | WorkspaceLocationUnavailableError {
  const { location } = input;
  if (location.base === "host") {
    return location.environmentId === input.environmentId
      ? location.path
      : new WorkspaceLocationUnavailableError({
          environmentId: input.environmentId,
          projectId: input.projectId,
          reason: `the path was recorded on Environment ${location.environmentId}`,
        });
  }
  if (input.checkout === null) {
    return new WorkspaceLocationUnavailableError({
      environmentId: input.environmentId,
      projectId: input.projectId,
      reason: "the project has no checkout there",
    });
  }
  return joinUnderRoot(input.checkout, location.path);
}

/**
 * The folder name a Project's default checkout gets on an Environment: the last segment of the
 * Hub machine's checkout, else the Project id, reduced to characters every filesystem accepts.
 */
export function projectCheckoutSlug(input: {
  readonly projectId: ProjectId;
  readonly hubCheckout: string | null;
}): string {
  const segments = (input.hubCheckout ?? "").split(SEPARATORS).filter((part) => part !== "");
  const candidate = (segments.at(-1) ?? "").replace(/[^A-Za-z0-9._-]+/g, "-");
  const slug = candidate.replace(/^[.-]+/, "");
  return slug.length > 0 ? slug : input.projectId.replace(/[^A-Za-z0-9._-]+/g, "-");
}
