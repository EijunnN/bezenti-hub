/**
 * What runs a Space's Sandbox: a joined T3 server with a home of its own (its volume, which is also
 * its workspace root) and its Environment credential. The process implementation runs it as a
 * child process, for tests and development; the Podman one in a rootless container. Nothing
 * outside an implementation talks to processes or containers. See docs/internals/sandboxes.md.
 */
import type { EnvironmentId, SpaceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type { SandboxLimits } from "./sandboxLimits.ts";

export type { SandboxLimits };

export type SandboxRuntimeKind = "process" | "podman";

/**
 * What one start of a Sandbox runs with. Read at each start, so a change applies on the next one.
 * `limits` are the effective ones (null: none); a runtime enforces what `limitSupport` says and
 * records the rest.
 */
export interface SandboxStartOptions {
  readonly limits?: SandboxLimits;
}

/**
 * Which of CPU, memory and PIDs a runtime enforces on this host, and why not when it does not, in
 * words for the Owner (Settings and the Hub's log show it). Disk is the Hub's own check.
 */
export interface SandboxLimitSupport {
  readonly cpus: boolean;
  readonly memory: boolean;
  readonly pids: boolean;
  readonly note: string | null;
}

/** What a running Sandbox uses now; null where the runtime cannot tell. */
export interface SandboxResourceUse {
  /** Percent of one CPU. */
  readonly cpuPercent: number | null;
  readonly memoryBytes: number | null;
}

/**
 * How a Sandbox reaches its Hub, for its Environment socket and the Hub's git repositories. Read
 * when a Sandbox starts, since a dev Hub's port can change between runs.
 */
export class SandboxHubAddress extends Context.Service<
  SandboxHubAddress,
  {
    /** The Hub's own loopback address. A container reaches a UNIX socket instead. */
    readonly loopbackUrl: Effect.Effect<string>;
  }
>()("t3/sandboxes/SandboxRuntime/SandboxHubAddress") {}

export interface SandboxSpec {
  /** One per Space, for its whole life: names its home and its container. */
  readonly sandboxId: string;
  readonly spaceId: SpaceId;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  /** The Hub's own id, which the credential names and its `welcome` must answer with. */
  readonly hubEnvironmentId: EnvironmentId;
  /** Kept in the Sandbox's home; the Hub keeps only its hash. */
  readonly credential: Redacted.Redacted<string>;
}

export type SandboxState =
  /** No home: never created, or deleted. */
  | { readonly _tag: "missing" }
  | { readonly _tag: "stopped" }
  | { readonly _tag: "running"; readonly pid: number | null; readonly startedAt: string };

export interface SandboxInspection {
  readonly state: SandboxState;
  /** Where its home is on the Hub's machine: a directory, or a volume's mount point. */
  readonly homePath: string;
}

/** A Sandbox's server ended without being stopped: it crashed or was killed. */
export interface SandboxExit {
  readonly sandboxId: string;
  readonly exitCode: number | null;
}

export class SandboxRuntimeError extends Schema.TaggedError<SandboxRuntimeError>()(
  "SandboxRuntimeError",
  { operation: Schema.String, sandboxId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `The Sandbox could not ${this.operation}: ${this.detail}`;
  }
}

export class SandboxRuntime extends Context.Service<
  SandboxRuntime,
  {
    readonly kind: SandboxRuntimeKind;
    /**
     * Makes the Sandbox's home and puts its credential and Hub there. On an existing home the
     * files stay and the credential and Hub are replaced, so a reissued credential takes effect
     * on the next start.
     */
    readonly create: (spec: SandboxSpec) => Effect.Effect<void, SandboxRuntimeError>;
    /**
     * Starts its server (nothing when it already runs). `exited` completes with its exit code when
     * that server ends, so a start that dies at once is not waited on.
     */
    readonly start: (
      sandboxId: string,
      options?: SandboxStartOptions,
    ) => Effect.Effect<{ readonly exited: Effect.Effect<number | null> }, SandboxRuntimeError>;
    /** Stops its server, keeping its home; nothing when it is not running. */
    readonly stop: (sandboxId: string) => Effect.Effect<void, SandboxRuntimeError>;
    /** Stops it and removes its home with everything in it. */
    readonly delete: (sandboxId: string) => Effect.Effect<void, SandboxRuntimeError>;
    readonly inspect: (sandboxId: string) => Effect.Effect<SandboxInspection, SandboxRuntimeError>;
    /** Which limits it enforces here; asked once and kept. */
    readonly limitSupport: Effect.Effect<SandboxLimitSupport>;
    /** What the running Sandbox uses now; null when it is not running or cannot be told. */
    readonly resourceUse: (sandboxId: string) => Effect.Effect<SandboxResourceUse | null>;
    /** Each server that ended without `stop` or `delete`. */
    readonly exits: Stream.Stream<SandboxExit>;
  }
>()("t3/sandboxes/SandboxRuntime") {}

/** A Space's Sandbox id: its Space id, safe as a directory or container name. */
export const sandboxIdOf = (spaceId: SpaceId) =>
  `sandbox-${spaceId.replace(/[^A-Za-z0-9_.-]/gu, "-")}`;
