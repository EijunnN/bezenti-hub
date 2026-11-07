import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../config.ts";
import { fromConfig, hubRunsAgentsFromConfig } from "./sandboxRuntimeFromConfig.ts";

/** A Hub's config (dev with `--dev-url`, or production) and its environment variables. */
const withHub = (env: Record<string, string>, options: { readonly dev: boolean }) =>
  Layer.mergeAll(
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
    Layer.effect(
      ServerConfig.ServerConfig,
      Effect.map(ServerConfig.ServerConfig, (base) => ({
        ...base,
        devUrl: options.dev ? new URL("http://127.0.0.1:5733") : undefined,
      })),
    ).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sandbox-config-" })),
      Layer.provide(NodeServices.layer),
    ),
  );

const hubRunsAgents = (env: Record<string, string>, options: { readonly dev: boolean }) =>
  hubRunsAgentsFromConfig.pipe(Effect.provide(withHub(env, options)));

describe("T3CODE_HUB_RUNS_AGENTS", () => {
  it.effect("is off for a production Hub unless it is turned on", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* hubRunsAgents({}, { dev: false }));
      assert.isFalse(yield* hubRunsAgents({ T3CODE_HUB_RUNS_AGENTS: "0" }, { dev: false }));
      assert.isFalse(yield* hubRunsAgents({ T3CODE_HUB_RUNS_AGENTS: "maybe" }, { dev: false }));
      assert.isTrue(yield* hubRunsAgents({ T3CODE_HUB_RUNS_AGENTS: "1" }, { dev: false }));
      assert.isTrue(yield* hubRunsAgents({ T3CODE_HUB_RUNS_AGENTS: "true" }, { dev: false }));
    }),
  );

  it.effect("is on for a dev Hub without Sandboxes, so it runs without Podman", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* hubRunsAgents({}, { dev: true }));
      assert.isTrue(yield* hubRunsAgents({ T3CODE_SANDBOX_RUNTIME: "off" }, { dev: true }));
      // A dev Hub that runs Sandboxes places Threads there, as production does.
      assert.isFalse(yield* hubRunsAgents({ T3CODE_SANDBOX_RUNTIME: "process" }, { dev: true }));
      assert.isFalse(yield* hubRunsAgents({ T3CODE_SANDBOX_RUNTIME: "podman" }, { dev: true }));
      assert.isTrue(
        yield* hubRunsAgents(
          { T3CODE_SANDBOX_RUNTIME: "process", T3CODE_HUB_RUNS_AGENTS: "1" },
          { dev: true },
        ),
      );
      assert.isFalse(yield* hubRunsAgents({ T3CODE_HUB_RUNS_AGENTS: "false" }, { dev: true }));
    }),
  );
});

describe("Sandbox runtime from config", () => {
  it.effect("says why a Hub runs no Sandboxes", () =>
    Effect.gen(function* () {
      const off = yield* fromConfig.pipe(
        Effect.provide(withHub({ T3CODE_SANDBOX_RUNTIME: "off" }, { dev: false })),
      );
      assert.isTrue(Option.isNone(off.runtime));
      assert.include(off.unavailable ?? "", "turned off");
      const dev = yield* fromConfig.pipe(Effect.provide(withHub({}, { dev: true })));
      assert.isTrue(Option.isNone(dev.runtime));
      assert.include(dev.unavailable ?? "", "T3CODE_SANDBOX_RUNTIME=process");
    }),
  );
});
