import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as PublicHubUrl from "./PublicHubUrl.ts";

const hubFor = (publicUrl: URL | undefined) =>
  PublicHubUrl.PublicHubUrl.pipe(
    Effect.flatMap((hub) => Effect.all({ host: hub.publicHubHost, origin: hub.publicHubOrigin })),
    Effect.provide(
      PublicHubUrl.layer.pipe(
        Layer.provide(
          Layer.effect(
            ServerConfig.ServerConfig,
            Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, publicUrl })),
          ).pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hub-url-" })),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  );

it.effect("gives links the host and origin of T3CODE_PUBLIC_URL, and none without it", () =>
  Effect.gen(function* () {
    expect(yield* hubFor(new URL("https://hub.example.com/"))).toEqual({
      host: Option.some("hub.example.com"),
      origin: Option.some("https://hub.example.com"),
    });
    expect(yield* hubFor(undefined)).toEqual({ host: Option.none(), origin: Option.none() });
  }),
);
