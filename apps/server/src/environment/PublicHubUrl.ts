import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

/**
 * The hostname other people reach this environment on, from the public Hub URL setting.
 *
 * Guest links point at it. Nothing configures it yet, so it is none and guest links refuse to
 * open; the public Hub URL setting (multi-user hub ticket 15) provides this reference once both
 * land.
 */
export class PublicHubUrl extends Context.Reference<{
  readonly publicHubHost: Effect.Effect<Option.Option<string>>;
}>("t3/environment/PublicHubUrl", {
  defaultValue: () => ({ publicHubHost: Effect.succeedNone }),
}) {}
