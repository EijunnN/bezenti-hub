/**
 * Environments the Hub starts for work and stops when idle (a Space's Sandbox): work that needs
 * one asks here instead of failing as offline, and what keeps one busy says so here. Absent on a
 * Hub without a Sandbox runtime. See docs/internals/sandboxes.md.
 */
import type { EnvironmentId, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/** It could not start: why, as the Thread shows it beside «Try again». */
export class EnvironmentStartError extends Schema.TaggedError<EnvironmentStartError>()(
  "EnvironmentStartError",
  { environmentId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `The Sandbox could not start: ${this.detail}`;
  }
}

export class EnvironmentDemand extends Context.Service<
  EnvironmentDemand,
  {
    /**
     * Whether work can go to it now: false only for a Sandbox not running (or being stopped).
     * Reads nothing else and counts as no use, so polling never keeps a Sandbox up.
     */
    readonly ready: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
    /**
     * Starts it unless it runs (joining a start under way) and waits until its executor serves;
     * counts as use. A failed Sandbox starts again only for a User's own action (`explicit`), after
     * a short backoff. The start is the Hub's: a caller that stops waiting does not stop it.
     */
    readonly awaitStarted: (
      environmentId: EnvironmentId,
      options: { readonly actorUserId?: UserId | undefined; readonly explicit: boolean },
    ) => Effect.Effect<void, EnvironmentStartError>;
    /**
     * Starts the startable ones among them that are stopped, without waiting; one whose last start
     * failed waits for a User («Try again», or new work that waits on it).
     */
    readonly request: (environmentIds: ReadonlyArray<EnvironmentId>) => Effect.Effect<void>;
    /** Work used it now: its idle time starts again. */
    readonly touch: (environmentId: EnvironmentId) => Effect.Effect<void>;
    /** Keeps it busy until the scope closes: an open terminal, a preview being served. */
    readonly hold: (environmentId: EnvironmentId) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/environment/EnvironmentDemand") {}
