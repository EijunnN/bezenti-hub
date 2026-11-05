import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";

/**
 * The hostname other people reach this environment on, from `T3CODE_PUBLIC_URL`.
 *
 * Guest links point at it. Without a public URL it is none and guest links refuse to open.
 */
export class PublicHubUrl extends Context.Reference<{
  readonly publicHubHost: Effect.Effect<Option.Option<string>>;
}>("t3/environment/PublicHubUrl", {
  defaultValue: () => ({ publicHubHost: Effect.succeedNone }),
}) {}

export const layer = Layer.effect(
  PublicHubUrl,
  Effect.map(ServerConfig.ServerConfig, (config) => ({
    publicHubHost: Effect.succeed(Option.fromUndefinedOr(config.publicUrl?.hostname)),
  })),
);
