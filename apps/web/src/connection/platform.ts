import {
  ClientCapabilities,
  PlatformConnectionSource,
  Persistence,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  mapRemoteEnvironmentError,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  sshTargetKey,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import {
  AuthStandardClientScopes,
  type DesktopBridge,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import { APP_VERSION } from "../branding";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import * as ConnectionStorage from "./storage";
import { clientPresentationMetadata } from "./clientMetadata";

let nextObservedRpcRequestId = 0;

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const layerConnectivity = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

interface NetworkInformationLike extends EventTarget {
  readonly type?: string;
}

// change also fires for same-network bandwidth and latency estimates; count only type changes.
const networkPathChanges = Stream.callback<"network-changed">((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const connection =
        typeof navigator === "undefined"
          ? undefined
          : (navigator as Navigator & { readonly connection?: NetworkInformationLike }).connection;
      if (connection?.type === undefined) return undefined;
      let previous = connection.type;
      const listener = () => {
        const type = connection.type;
        if (type === undefined || type === previous) return;
        previous = type;
        Queue.offerUnsafe(queue, "network-changed");
      };
      connection.addEventListener("change", listener);
      return { connection, listener };
    }),
    (subscription) =>
      Effect.sync(() =>
        subscription?.connection.removeEventListener("change", subscription.listener),
      ),
  ).pipe(Effect.asVoid),
);

const layerWakeups = Wakeups.layer({
  changes: Stream.mergeAll(
    [
      Stream.callback<"application-active">((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = () => {
              if (document.visibilityState === "visible") {
                Queue.offerUnsafe(queue, "application-active");
              }
            };
            document.addEventListener("visibilitychange", listener);
            return listener;
          }),
          (listener) =>
            Effect.sync(() => {
              document.removeEventListener("visibilitychange", listener);
            }),
        ).pipe(Effect.asVoid),
      ),
      networkPathChanges,
    ],
    { concurrency: "unbounded" },
  ),
});

export function currentClientMetadata() {
  return clientPresentationMetadata({
    appVersion: APP_VERSION,
    identity: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    desktopBridge: window.desktopBridge,
  });
}

function sshPreparationError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.toLowerCase().includes("cancel")) {
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: message,
    });
  }
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not prepare the SSH environment: ${message}`,
  });
}

// IPC keeps running after its waiter is interrupted. A retry can adopt only
// that interrupted waiter's unfinished setup.
const pendingSshSetups = new Map<
  string,
  { readonly promise: Promise<DesktopSshEnvironmentBootstrap>; signal: AbortSignal }
>();

const ensureDesktopSshEnvironment = (bridge: DesktopBridge, target: DesktopSshEnvironmentTarget) =>
  Effect.tryPromise({
    try: (signal) => {
      const key = sshTargetKey(target);
      const pending = pendingSshSetups.get(key);
      if (pending?.signal.aborted) {
        pending.signal = signal;
        return pending.promise;
      }
      const setup = {
        promise: bridge.ensureSshEnvironment(target, { issuePairingToken: true }),
        signal,
      };
      pendingSshSetups.set(key, setup);
      const forget = () => {
        if (pendingSshSetups.get(key) === setup) pendingSshSetups.delete(key);
      };
      setup.promise.then(forget, forget);
      return setup.promise;
    },
    catch: sshPreparationError,
  });

export const provisionDesktopSshEnvironment = Effect.fn(
  "web.connectionPlatform.ssh.provisionDesktop",
)(function* (
  bridge: DesktopBridge,
  target: DesktopSshEnvironmentTarget,
  expectedEnvironmentId?: EnvironmentId,
) {
  const bootstrap = yield* ensureDesktopSshEnvironment(bridge, target);
  const pairingToken = bootstrap.pairingToken;
  if (pairingToken === null) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The SSH environment did not issue a pairing credential.",
    });
  }
  const descriptor = yield* Effect.tryPromise({
    try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
    catch: sshPreparationError,
  });
  if (expectedEnvironmentId !== undefined && descriptor.environmentId !== expectedEnvironmentId) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: `That host reaches ${descriptor.label}, a different machine. Add it as its own environment instead.`,
    });
  }
  const access = yield* Effect.tryPromise({
    try: () => bridge.bootstrapSshBearerSession(bootstrap.httpBaseUrl, pairingToken),
    catch: (cause) => {
      const error = sshPreparationError(cause);
      // A reused remote server on another build can fail to decode the grant
      // the desktop's runner just minted, and answers 500 on every retry.
      if (
        error._tag === "ConnectionBlockedError" ||
        descriptor.serverVersion === APP_VERSION ||
        !error.detail.includes("[ssh_http:500]")
      ) {
        return error;
      }
      return new ConnectionBlockedError({
        reason: "configuration",
        detail: `${descriptor.label} runs T3 Code ${descriptor.serverVersion}, but this desktop is ${APP_VERSION}, and that server could not accept its pairing. Restart the T3 server on ${descriptor.label} so it runs ${APP_VERSION}, then retry.`,
      });
    },
  });
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    bootstrap,
    bearerToken: access.access_token,
  };
});

/** Reuses SSH pairing tokens with all standard scopes to avoid adding a session on each connection. */
export const prepareDesktopSshEnvironment = Effect.fn("web.connectionPlatform.ssh.prepareDesktop")(
  function* (
    bridge: DesktopBridge,
    input: {
      readonly target: DesktopSshEnvironmentTarget;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly bearerToken?: string;
    },
  ) {
    const bearerToken = input.bearerToken;
    if (bearerToken !== undefined) {
      const bootstrap = yield* Effect.tryPromise({
        try: () => bridge.ensureSshEnvironment(input.target, { issuePairingToken: false }),
        catch: sshPreparationError,
      });
      // Check identity before sending saved credentials or pairing.
      const descriptor = yield* Effect.tryPromise({
        try: () => bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl),
        catch: sshPreparationError,
      });
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: `That host reaches ${descriptor.label}, a different machine. Add it as its own environment instead.`,
        });
      }
      const session = yield* Effect.tryPromise({
        try: () => bridge.fetchSshSessionState(bootstrap.httpBaseUrl, bearerToken),
        catch: sshPreparationError,
      });
      // Stored grants never widen; re-pair tokens missing newer standard scopes.
      const granted = session.permissions ?? session.scopes ?? [];
      if (
        session.authenticated &&
        AuthStandardClientScopes.every((scope) => granted.includes(scope))
      ) {
        return { bootstrap, bearerToken };
      }
    }
    const provisioned = yield* provisionDesktopSshEnvironment(
      bridge,
      input.target,
      input.expectedEnvironmentId,
    );
    return { bootstrap: provisioned.bootstrap, bearerToken: provisioned.bearerToken };
  },
);

const layerCapabilities = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientCapabilities.ClientPresentation.of({
      metadata: currentClientMetadata(),
    });
    const primaryAuth = ClientCapabilities.PrimaryEnvironmentAuth.of({
      bearerToken: Effect.tryPromise({
        try: readDesktopPrimaryBearerToken,
        catch: (cause) =>
          new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: `Could not load the desktop primary credential: ${String(cause)}`,
          }),
      }).pipe(Effect.map(Option.fromNullishOr)),
    });
    const ssh = ClientCapabilities.SshEnvironmentGateway.of({
      provision: Effect.fn("web.connectionPlatform.ssh.provision")(
        function* (target, expectedEnvironmentId) {
          const bridge = window.desktopBridge;
          if (bridge === undefined) {
            return yield* new ConnectionBlockedError({
              reason: "unsupported",
              detail: "SSH environments are only available in the desktop app.",
            });
          }
          return yield* provisionDesktopSshEnvironment(bridge, target, expectedEnvironmentId);
        },
      ),
      prepare: Effect.fn("web.connectionPlatform.ssh.prepare")(function* (input) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return yield* new ConnectionBlockedError({
            reason: "unsupported",
            detail: "SSH environments are only available in the desktop app.",
          });
        }
        return yield* prepareDesktopSshEnvironment(bridge, input);
      }),
      disconnect: Effect.fn("web.connectionPlatform.ssh.disconnect")(function* (target) {
        const bridge = window.desktopBridge;
        if (bridge === undefined) {
          return;
        }
        pendingSshSetups.delete(sshTargetKey(target));
        yield* Effect.tryPromise({
          try: () => bridge.disconnectSshEnvironment(target),
          catch: (cause) =>
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: `Could not disconnect the SSH environment: ${String(cause)}`,
            }),
        });
      }),
    });

    return Context.make(ClientCapabilities.PrimaryEnvironmentAuth, primaryAuth).pipe(
      Context.add(ClientCapabilities.ClientPresentation, presentation),
      Context.add(ClientCapabilities.SshEnvironmentGateway, ssh),
    );
  }),
);

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)(function* (resolved: PrimaryEnvironmentTarget) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: resolved.target.httpBaseUrl,
  }).pipe(
    Effect.provide(PrimaryEnvironmentHttpLayer.layer),
    Effect.mapError(mapRemoteEnvironmentError),
  );
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    }),
  });
});

// The bridge has no topology event: poll it, and keep the registration while the target is unchanged.
const PLATFORM_POLL_INTERVAL = "3 seconds";

interface CachedPlatformRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
}

export type PrimaryEnvironmentTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: PrimaryEnvironmentTarget | null;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

function readPrimaryEnvironmentTargetResult(
  readTarget: () => PrimaryEnvironmentTarget | null = readPrimaryEnvironmentTarget,
): PrimaryEnvironmentTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

export function primaryRegistrationToRetainAfterTopologyRead(
  previous: ReadonlyMap<string, CachedPlatformRegistration>,
  topologyRead: PrimaryEnvironmentTargetRead,
): CachedPlatformRegistration | undefined {
  return topologyRead._tag === "Failure" ? previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID) : undefined;
}

const layerPlatformConnectionSource = Layer.effect(
  PlatformConnectionSource.PlatformConnectionSource,
  Effect.gen(function* () {
    if (isLocalEnvironmentDisabled()) {
      return PlatformConnectionSource.PlatformConnectionSource.of({
        registrations: Stream.empty,
      });
    }
    const cacheRef = yield* Ref.make(new Map<string, CachedPlatformRegistration>());

    const buildPlatformRegistrations = Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const next = new Map<string, CachedPlatformRegistration>();
      const registrations: Array<PlatformConnectionRegistration> = [];

      const primaryTopologyRead = readPrimaryEnvironmentTargetResult();
      const retainedPrimary = primaryRegistrationToRetainAfterTopologyRead(
        previous,
        primaryTopologyRead,
      );
      if (retainedPrimary !== undefined) {
        next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, retainedPrimary);
        registrations.push(retainedPrimary.registration);
      }

      if (primaryTopologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the primary environment topology.", {
          cause: primaryTopologyRead.cause,
        });
      } else if (primaryTopologyRead.target !== null) {
        const primaryTarget = primaryTopologyRead.target;
        const signature = `primary|${primaryTarget.target.httpBaseUrl}|${primaryTarget.target.wsBaseUrl}`;
        const cached = previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
        if (cached !== undefined && cached.signature === signature) {
          next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cached);
          registrations.push(cached.registration);
        } else {
          const built = yield* loadPrimaryConnectionRegistration(primaryTarget).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not discover the primary environment.", { error }),
            ),
            Effect.option,
          );
          if (Option.isSome(built)) {
            const cacheEntry = { signature, registration: built.value };
            next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cacheEntry);
            registrations.push(built.value);
          }
        }
      }

      // Only the Hub: a desktop's other local backends (WSL, a joined server) are not connected.
      yield* Ref.set(cacheRef, next);
      return registrations as ReadonlyArray<PlatformConnectionRegistration>;
    }).pipe(Effect.provide(FetchHttpClient.layer));

    return PlatformConnectionSource.PlatformConnectionSource.of({
      registrations: Stream.tick(PLATFORM_POLL_INTERVAL).pipe(
        Stream.mapEffect(() => buildPlatformRegistrations),
      ),
    });
  }),
);

const layerEnvironmentOwnedDataCleanup = Layer.succeed(
  Persistence.EnvironmentOwnedDataCleanup,
  Persistence.EnvironmentOwnedDataCleanup.of({
    clear: Effect.fn("Persistence.EnvironmentOwnedDataCleanup.clear")(function (environmentId) {
      return Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      });
    }),
  }),
);

const layerRpcRequestObserver = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    // Every RPC passes through this observer; the request owns its span.
    observe: Effect.fnUntraced(function* ({ environmentId, environmentLabel, method }) {
      return yield* Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, method, `${method} · ${environmentLabel}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      });
    }),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof ConnectionStorage.layer
  | typeof layerConnectivity
  | typeof layerWakeups
  | typeof layerCapabilities
  | typeof layerPlatformConnectionSource
  | typeof layerEnvironmentOwnedDataCleanup
  | typeof layerRpcRequestObserver;

export const layer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  ConnectionStorage.layer,
  layerConnectivity,
  layerWakeups,
  layerCapabilities,
  layerPlatformConnectionSource,
  layerEnvironmentOwnedDataCleanup,
  layerRpcRequestObserver,
);
