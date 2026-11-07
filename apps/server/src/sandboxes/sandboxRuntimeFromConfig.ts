// @effect-diagnostics nodeBuiltinImport:off -- finds a dev Hub's checkout from its entry point.
/**
 * Which Sandbox runtime a Hub runs, if any. `T3CODE_SANDBOX_RUNTIME` picks one (`podman`, or
 * `process` for development; `off` for none). Unset, a production Hub runs Podman when rootless
 * Podman is here and the Sandbox image is built; otherwise it offers no Sandbox. See
 * docs/internals/sandboxes.md.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import * as PodmanSandboxRuntime from "./PodmanSandboxRuntime.ts";
import { hostExposureRefusal, listeningOutsideLoopback } from "./hostExposure.ts";
import * as ProcessSandboxRuntime from "./ProcessSandboxRuntime.ts";
import { checkoutOf, configuredSandboxImage } from "./SandboxImage.ts";
import { SandboxHubAddress } from "./SandboxRuntime.ts";

const SANDBOX_RUNTIME_SETTING = "T3CODE_SANDBOX_RUNTIME";
/** Ports of a dedicated machine its Sandbox may reach, comma-separated (for example `22`). */
const DEDICATED_HOST_PORTS_SETTING = "T3CODE_DEDICATED_HOST_PORTS";

const optionalSetting = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/**
 * What a dev Hub mounts of its checkout, read-only, for its Sandboxes to run the server from
 * source: the server, the workspace packages and the installed modules; nothing else of it.
 */
export const devCodeMounts = (checkout: string) =>
  ["apps/server", "packages", "node_modules"]
    .map((dir) => NodePath.join(checkout, dir))
    .filter((dir) => NodeFS.existsSync(dir));

/**
 * Whether a Hub bound to `host` may run Podman Sandboxes: only one listening on loopback alone,
 * since a container reaches every address of the host but its loopback.
 */
export const hubHostAllowsPodman = (host: string | undefined) =>
  host !== undefined &&
  (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/u.test(host));

/** Whether rootless Podman is here and has `image`: asked once per Hub, a few seconds at most. */
let podmanDetection: Promise<{ rootless: boolean; image: boolean }> | undefined;
const detectPodman = (image: string) =>
  Effect.promise(() => {
    podmanDetection ??= Effect.runPromise(
      Effect.all(
        [
          PodmanSandboxRuntime.detectRootlessPodman(),
          PodmanSandboxRuntime.runPodman(["image", "exists", image], { timeoutMs: 5_000 }),
        ],
        { concurrency: 2 },
      ).pipe(Effect.map(([rootless, exists]) => ({ rootless, image: exists.exitCode === 0 }))),
    );
    return podmanDetection;
  });

/**
 * The Podman runtime as a Hub runs it. The base image runs its own `t3`. A Hub run from source
 * (`src/bin.ts`, a dev Hub) given a dev image (one it did not build: node and git only) mounts
 * {@link devCodeMounts} and runs its source with the image's Node.
 */
const podmanForHub = (config: { readonly devUrl: URL | undefined }, image: string) => {
  const entry = process.argv[1];
  const checkout = entry !== undefined && entry.endsWith(".ts") ? checkoutOf(entry) : undefined;
  return PodmanSandboxRuntime.layer({
    image,
    ...(checkout === undefined || entry === undefined
      ? {}
      : {
          devServer: {
            serverCommand: ["node", NodePath.resolve(entry)],
            codeMounts: devCodeMounts(checkout),
          },
        }),
    devUrl: config.devUrl?.toString(),
  });
};

/**
 * The runtime a dedicated machine runs its one Sandbox with, reaching the Hub at `hubUrl` (its
 * https address): Podman by default, which must be rootless with the Sandbox image built; the
 * process one only when `T3CODE_SANDBOX_RUNTIME=process` asks for it (development and tests).
 * Fails with why there is none, as `t3 status` shows it.
 */
export const dedicatedRuntimeFromConfig = Effect.fn("dedicatedRuntimeFromConfig")(function* (
  hubUrl: string,
) {
  const setting = Option.getOrUndefined(yield* optionalSetting(SANDBOX_RUNTIME_SETTING));
  const config = yield* ServerConfig.ServerConfig;
  const address = Layer.succeed(
    SandboxHubAddress,
    SandboxHubAddress.of({ loopbackUrl: Effect.succeed(hubUrl) }),
  );
  if (setting === "process") {
    const processRuntime = ProcessSandboxRuntime.forHub(config);
    return Option.isNone(processRuntime)
      ? Result.fail("this server has no entry point to run its Sandbox's server with.")
      : Result.succeed(processRuntime.value.pipe(Layer.provide(address)));
  }
  if (setting !== undefined && setting !== "podman") {
    return Result.fail(
      `a dedicated machine runs its work in a Sandbox container, and ${SANDBOX_RUNTIME_SETTING}=${setting} runs none.`,
    );
  }
  const image = yield* configuredSandboxImage;
  const detected = yield* detectPodman(image);
  if (!detected.rootless) {
    return Result.fail(
      "a dedicated machine runs its work in a Sandbox container, and rootless Podman is not available here.",
    );
  }
  if (!detected.image) {
    return Result.fail(
      `Podman is here but the Sandbox image ${image} is not: build it (\`t3 sandbox image build\`) or set T3CODE_SANDBOX_IMAGE.`,
    );
  }
  // The container reaches every address of this machine but its loopback, and rootless Podman
  // cannot firewall that: nothing may listen there unless the Owner named it.
  const allowed = new Set(
    Option.getOrElse(yield* optionalSetting(DEDICATED_HOST_PORTS_SETTING), () => "")
      .split(",")
      .map((port) => Number.parseInt(port.trim(), 10))
      .filter(Number.isFinite),
  );
  const exposed = hostExposureRefusal(
    // This server's own port answers only `/health`.
    listeningOutsideLoopback().filter((listener) => listener.port !== config.port),
    allowed,
  );
  if (exposed !== undefined) return Result.fail(exposed);
  return Result.succeed(podmanForHub(config, image).pipe(Layer.provide(address)));
});

/** Whether rootless Podman is here, as `t3 join --dedicated` checks before asking. */
export const rootlessPodmanHere = () => PodmanSandboxRuntime.detectRootlessPodman();

export const fromConfig = Effect.gen(function* () {
  const setting = Option.getOrUndefined(yield* optionalSetting(SANDBOX_RUNTIME_SETTING));
  const config = yield* ServerConfig.ServerConfig;
  if (setting === "off") return Option.none();
  if (setting !== undefined && setting !== "process" && setting !== "podman") {
    yield* Effect.logWarning(
      `Sandboxes are off: ${SANDBOX_RUNTIME_SETTING}=${setting} is not podman, process or off.`,
    );
    return Option.none();
  }
  // A joined machine runs no Hub Sandboxes (a dedicated one runs its own, through
  // `dedicatedRuntimeFromConfig`); unset, only a production Hub looks for Podman, not a dev Hub.
  if (config.joinedHub !== undefined || (setting === undefined && config.devUrl !== undefined)) {
    return Option.none();
  }
  const hubUrl = ProcessSandboxRuntime.sandboxHubLoopbackUrl(config);
  const addressOf = (url: string) =>
    Layer.succeed(SandboxHubAddress, SandboxHubAddress.of({ loopbackUrl: Effect.succeed(url) }));
  if (setting === "process") {
    if (hubUrl === undefined) {
      yield* Effect.logWarning("Sandboxes are off: the Hub does not listen on loopback.");
      return Option.none();
    }
    return Option.map(ProcessSandboxRuntime.forHub(config), Layer.provide(addressOf(hubUrl)));
  }
  const image = yield* configuredSandboxImage;
  if (hubUrl === undefined || !hubHostAllowsPodman(config.host)) {
    // Said whenever Podman could have run them, so a Hub left on 0.0.0.0 learns why it has none.
    if (setting === "podman" || (yield* detectPodman(image)).rootless) {
      yield* Effect.logWarning(
        "Sandboxes are off: Podman is here, but Podman Sandboxes need the Hub to listen on loopback only (T3CODE_HOST=127.0.0.1, published through a reverse proxy or `t3 up`), since a container reaches every other address of this machine.",
      );
    }
    return Option.none();
  }
  const detected = yield* detectPodman(image);
  if (!detected.rootless) {
    if (setting === "podman") {
      yield* Effect.logWarning("Sandboxes are off: rootless Podman is not available here.");
    }
    return Option.none();
  }
  if (setting === undefined && !detected.image) {
    yield* Effect.logInfo(
      `Sandboxes are off: Podman is here but the image ${image} is not built. Build it with \`t3 sandbox image build\` and restart the Hub.`,
    );
    return Option.none();
  }
  return Option.some(podmanForHub(config, image).pipe(Layer.provide(addressOf(hubUrl))));
});

/**
 * The Sandbox image this machine would run (`T3CODE_SANDBOX_IMAGE`, else this version's), and
 * whether it is built here, as `t3 join --dedicated` checks before asking.
 */
export const sandboxImageHere = Effect.gen(function* () {
  const image = yield* configuredSandboxImage;
  const exists = yield* PodmanSandboxRuntime.runPodman(["image", "exists", image], {
    timeoutMs: 15_000,
  });
  return { image, built: exists.exitCode === 0 };
});
