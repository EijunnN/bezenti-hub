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

export type SandboxRuntimeKind = "process" | "podman";

/** Null means the runtime's default (none, for the process runtime). */
export interface SandboxLimits {
  readonly cpus: number | null;
  readonly memoryBytes: number | null;
  readonly pids: number | null;
  readonly diskBytes: number | null;
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
  readonly limits: SandboxLimits;
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

export interface SandboxStarted {
  readonly exited: Effect.Effect<number | null>;
  readonly imageVersion: string | null;
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
     * that server ends, so a start that dies at once is not waited on. `imageVersion` is the
     * version of the base image it runs (null without one, as the process runtime).
     */
    readonly start: (sandboxId: string) => Effect.Effect<SandboxStarted, SandboxRuntimeError>;
    /** The base image version a start would run now: the newest built. */
    readonly imageVersion: Effect.Effect<string | null, SandboxRuntimeError>;
    /** Stops its server, keeping its home; nothing when it is not running. */
    readonly stop: (sandboxId: string) => Effect.Effect<void, SandboxRuntimeError>;
    /** Stops it and removes its home with everything in it. */
    readonly delete: (sandboxId: string) => Effect.Effect<void, SandboxRuntimeError>;
    readonly inspect: (sandboxId: string) => Effect.Effect<SandboxInspection, SandboxRuntimeError>;
    /** Each server that ended without `stop` or `delete`. */
    readonly exits: Stream.Stream<SandboxExit>;
  }
>()("t3/sandboxes/SandboxRuntime") {}

/** A Space's Sandbox id: its Space id, safe as a directory or container name. */
export const sandboxIdOf = (spaceId: SpaceId) =>
  `sandbox-${spaceId.replace(/[^A-Za-z0-9_.-]/gu, "-")}`;
