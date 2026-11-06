import { addHubOrigin } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";

/**
 * The address other people reach this Hub on, from `T3CODE_PUBLIC_URL`: the one source for the
 * absolute links the Hub hands out (ADR 0007).
 *
 * Guest links point at its host and refuse to open without it. Thread links for outside MCP
 * clients use its origin, else the origin the request came in on.
 */
export class PublicHubUrl extends Context.Reference<{
  readonly publicHubHost: Effect.Effect<Option.Option<string>>;
  readonly publicHubOrigin: Effect.Effect<Option.Option<string>>;
}>("t3/environment/PublicHubUrl", {
  defaultValue: () => ({ publicHubHost: Effect.succeedNone, publicHubOrigin: Effect.succeedNone }),
}) {}

export const layer = Layer.effect(
  PublicHubUrl,
  Effect.map(ServerConfig.ServerConfig, (config) => {
    // Links to this Hub that come back in messages read as thread links.
    addHubOrigin(config.publicUrl?.origin);
    return {
      publicHubHost: Effect.succeed(Option.fromUndefinedOr(config.publicUrl?.hostname)),
      publicHubOrigin: Effect.succeed(Option.fromUndefinedOr(config.publicUrl?.origin)),
    };
  }),
);
