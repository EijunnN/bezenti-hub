import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as PublicHubUrl from "./PublicHubUrl.ts";

const hostFor = (publicUrl: URL | undefined) =>
  PublicHubUrl.PublicHubUrl.pipe(
    Effect.flatMap((hub) => hub.publicHubHost),
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

it.effect("gives guest links the host of T3CODE_PUBLIC_URL, and none without it", () =>
  Effect.gen(function* () {
    expect(yield* hostFor(new URL("https://hub.example.com"))).toEqual(
      Option.some("hub.example.com"),
    );
    expect(yield* hostFor(undefined)).toEqual(Option.none());
  }),
);
