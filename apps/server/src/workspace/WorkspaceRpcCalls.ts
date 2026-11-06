/**
 * The workspace RPCs (files, search, browse) on one machine's own services, with their failures as
 * the RPC contract's errors. The Hub machine answers its clients with them, and a joined
 * Environment answers its Hub with the same, so a client reads one error shape from either.
 */
import {
  FilesystemBrowseError,
  type FilesystemBrowseFailure,
  type FilesystemBrowseInput,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  ProjectListEntriesError,
  type ProjectListEntriesInput,
  type ProjectListIgnoredFilesInput,
  ProjectReadFileError,
  type ProjectReadFileInput,
  ProjectSearchContentsError,
  type ProjectSearchContentsInput,
  ProjectSearchEntriesError,
  type ProjectSearchEntriesInput,
  ProjectWriteFileError,
  type ProjectWriteFileInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as KnownWorkspaces from "./KnownWorkspaces.ts";
import type * as WorkspaceEntries from "./WorkspaceEntries.ts";
import type * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "./WorkspacePaths.ts";

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "directory_list_failed",
        ...(error.cwd !== undefined ? { normalizedCwd: error.cwd } : {}),
        detail: error.message,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError
    | KnownWorkspaces.UnknownWorkspaceError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
    case "UnknownWorkspaceError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

/** Drops the routing field: the machine that answers is already the Thread's. */
const local = <A extends { readonly threadId?: unknown }>({ threadId: _threadId, ...input }: A) =>
  input as Omit<A, "threadId">;

export const makeWorkspaceRpcCalls = (services: {
  readonly entries: WorkspaceEntries.WorkspaceEntries["Service"];
  readonly files: WorkspaceFileSystem.WorkspaceFileSystem["Service"];
}) => ({
  searchEntries: (input: ProjectSearchEntriesInput) =>
    services.entries.search(local(input)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSearchEntriesError({
            cwd: input.cwd,
            queryLength: input.query.length,
            limit: input.limit,
            ...projectEntriesFailureContext(cause),
            cause,
          }),
      ),
    ),
  searchContents: (input: ProjectSearchContentsInput) =>
    services.entries.searchContents(local(input)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSearchContentsError({
            cwd: input.cwd,
            queryLength: input.query.length,
            limit: input.limit,
            ...projectEntriesFailureContext(cause),
            cause,
          }),
      ),
    ),
  listEntries: (input: ProjectListEntriesInput) =>
    services.entries.list(local(input)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectListEntriesError({
            ...local(input),
            ...projectEntriesFailureContext(cause),
            cause,
          }),
      ),
    ),
  listIgnoredFiles: (input: ProjectListIgnoredFilesInput) =>
    services.entries.listIgnoredFiles(local(input)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectListEntriesError({
            ...local(input),
            ...projectEntriesFailureContext(cause),
            cause,
          }),
      ),
    ),
  readFile: (input: ProjectReadFileInput) =>
    services.files.readFile(local(input)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectReadFileError({
            ...local(input),
            ...projectFileFailureContext(cause),
            cause,
          }),
      ),
    ),
  writeFile: (input: ProjectWriteFileInput) =>
    services.files.writeFile(local(input)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectWriteFileError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            ...projectFileFailureContext(cause),
            cause,
          }),
      ),
    ),
  browse: (input: FilesystemBrowseInput) =>
    services.entries.browse(local(input)).pipe(
      Effect.mapError(
        (cause) =>
          new FilesystemBrowseError({
            ...local(input),
            ...filesystemBrowseFailureContext(cause),
            cause,
          }),
      ),
    ),
});
