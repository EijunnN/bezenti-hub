import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../config.ts";
import * as HubRunsAgents from "../environment/HubRunsAgents.ts";
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
  const devRunner = { T3CODE_DEV_RUNNER: "1" };
  it.effect("is never honored by a production Hub", () =>
    Effect.gen(function* () {
      for (const value of [undefined, "0", "maybe", "1", "true"]) {
        const env = value === undefined ? {} : { T3CODE_HUB_RUNS_AGENTS: value };
        assert.isFalse(yield* hubRunsAgents(env, { dev: false }), value);
        // Nor by one that only inherited a dev URL, without the dev runner's own flag.
        assert.isFalse(yield* hubRunsAgents(env, { dev: true }), value);
        assert.isFalse(yield* hubRunsAgents({ ...env, ...devRunner }, { dev: false }), value);
      }
    }),
  );

  it.effect("is on for a dev runner Hub without Sandboxes, so it runs without Podman", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* hubRunsAgents(devRunner, { dev: true }));
      assert.isTrue(
        yield* hubRunsAgents({ ...devRunner, T3CODE_SANDBOX_RUNTIME: "off" }, { dev: true }),
      );
      // A dev Hub that runs Sandboxes places Threads there, as production does.
      assert.isFalse(
        yield* hubRunsAgents({ ...devRunner, T3CODE_SANDBOX_RUNTIME: "process" }, { dev: true }),
      );
      assert.isFalse(
        yield* hubRunsAgents({ ...devRunner, T3CODE_SANDBOX_RUNTIME: "podman" }, { dev: true }),
      );
      assert.isTrue(
        yield* hubRunsAgents(
          { ...devRunner, T3CODE_SANDBOX_RUNTIME: "process", T3CODE_HUB_RUNS_AGENTS: "1" },
          { dev: true },
        ),
      );
      assert.isFalse(
        yield* hubRunsAgents({ ...devRunner, T3CODE_HUB_RUNS_AGENTS: "false" }, { dev: true }),
      );
    }),
  );
});

describe("HubRunsAgents", () => {
  it.effect("is off wherever the server did not provide it: nothing runs agents by default", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* HubRunsAgents.HubRunsAgents);
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
      // Only that is the Owner's choice: their Threads need an environment. Any other reason
      // may pass, and they wait.
      assert.isTrue(off.turnedOff);
      const dev = yield* fromConfig.pipe(Effect.provide(withHub({}, { dev: true })));
      assert.isTrue(Option.isNone(dev.runtime));
      assert.include(dev.unavailable ?? "", "T3CODE_SANDBOX_RUNTIME=process");
      assert.isFalse(dev.turnedOff);
    }),
  );
});
