/**
 * Previews through the Hub: `/preview/<token>/` relays to a dev server's port on a Thread's Active
 * environment, for one User's session, checked again on every request. See
 * docs/internals/sandboxes.md#previews-through-the-hub.
 */
import {
  type AuthSessionId,
  type EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  HUB_PREVIEW_ROUTE_PREFIX,
  PreviewEnvironmentUnavailableError,
  type PreviewProxyUrl,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as SessionStore from "../auth/SessionStore.ts";
import * as UserDirectory from "../auth/UserDirectory.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentDemand from "../environment/EnvironmentDemand.ts";
import * as EnvironmentExecutor from "../environment/EnvironmentExecutor.ts";
import * as EnvironmentRegistry from "../environments/EnvironmentRegistry.ts";
import * as SpaceDirectory from "../spaces/SpaceDirectory.ts";
import * as SpaceVisibility from "../spaces/SpaceVisibility.ts";
import { newPreviewId } from "./PreviewOrigin.ts";
import {
  PREVIEW_PROXY_CONTRACT_VERSION,
  PreviewProxyError,
  type PreviewProxyTarget,
} from "./PreviewProxy.ts";

/** An address stops working after this long unused; asking again gives it back. */
export const PREVIEW_ADDRESS_IDLE_TTL_MS = 60 * 60 * 1000;
/** Addresses one User keeps; past it their least recently used goes, never anyone else's. */
const MAX_ADDRESSES_PER_USER = 32;
/** How long one request's authorization answers the next ones under the same address. */
const CHECK_CACHE_MS = 2_000;

export interface PreviewAddress {
  readonly token: string;
  /** As the minting principal named it; none for a principal acting as the Owner. */
  readonly userId: UserId | undefined;
  /** Who it is for: the User, or the Owner for a principal without one (none before an Owner). */
  readonly principal: UserId | undefined;
  readonly sessionId: AuthSessionId;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly port: number;
  /** The preview cookie's value: given to a browser that opened the page signed in. */
  readonly pass: string;
  /**
   * Its subdomain under `T3CODE_PREVIEW_ORIGIN` (`newPreviewId`): its own, never another
   * address's, so no two Users, Spaces or sessions share an origin.
   */
  readonly originId: string;
  expiresAtMillis: number;
}

/** How long a handoff into a preview's own origin may wait to be spent; once only. */
const PREVIEW_HANDOFF_TTL_MS = 60_000;
/** Handoffs a User holds unspent: past this their own oldest go, never another User's. */
export const MAX_HANDOFFS_PER_USER = 16;

/** Who a request says it is: its Hub session's User, and the preview cookie it carries. */
export interface PreviewCredentials {
  /** Some when the request carries a valid Hub session (its User, none for no User). */
  readonly hubUser: Option.Option<UserId | undefined>;
  readonly pass: Option.Option<string>;
}

/** What one request under an address reaches, checked as it comes. */
export type PreviewResolution =
  | { readonly _tag: "refused" }
  | { readonly _tag: "unauthenticated" }
  | { readonly _tag: "offline"; readonly name: string | undefined }
  | {
      readonly _tag: "open";
      readonly address: PreviewAddress;
      readonly target: PreviewProxyTarget;
      /** The machine's name, for saying it went offline. */
      readonly name: string | undefined;
    };

type Checked =
  | { readonly _tag: "refused" }
  | { readonly _tag: "offline"; readonly name: string | undefined }
  | {
      readonly _tag: "open";
      readonly target: PreviewProxyTarget;
      readonly name: string | undefined;
    };

const REFUSED = { _tag: "refused" } as const;

export class HubPreviews extends Context.Service<
  HubPreviews,
  {
    /**
     * The address of `port` on the Thread's Active environment for the session's User: the same
     * one while it lasts, a new one after.
     */
    readonly address: (input: {
      readonly userId: UserId | undefined;
      readonly sessionId: AuthSessionId;
      readonly threadId: ThreadId;
      readonly port: number;
    }) => Effect.Effect<PreviewProxyUrl, PreviewEnvironmentUnavailableError>;
    /** Checks one request under `token`. */
    readonly resolve: (
      token: string,
      credentials: PreviewCredentials,
    ) => Effect.Effect<PreviewResolution>;
    /**
     * Checks one request on a preview's own origin: only that origin's cookie counts (the Hub's
     * session never reaches it), then the same check as `resolve`.
     */
    readonly resolveOrigin: (
      originId: string,
      pass: Option.Option<string>,
    ) => Effect.Effect<PreviewResolution>;
    /**
     * A one-time code that lets a browser into the address's own origin, for a request
     * `resolve` just opened with its User's Hub session; it lasts `PREVIEW_HANDOFF_TTL_MS`.
     */
    readonly handoff: (address: PreviewAddress) => Effect.Effect<string>;
    /** Spends a handoff code on the origin it was made for: the address's cookie value. */
    readonly redeemHandoff: (
      originId: string,
      code: string,
    ) => Effect.Effect<Option.Option<PreviewAddress>>;
    /**
     * Completes once the address's User may no longer use it (session ended, access changed, the
     * Thread moved, the address expired): a live socket under it closes then.
     */
    readonly whileAllowed: (address: PreviewAddress) => Effect.Effect<void>;
    /** The Hub's own listening ports (its HTTP server's), which no address ever reaches. */
    readonly hubPorts: (ports: ReadonlyArray<number>) => Effect.Effect<void>;
  }
>()("t3/preview/HubPreviews") {}

/** 256 random bits, URL-safe: an address's token, which is as good as a credential. */
export const randomToken = () => {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
};

/** A machine's dev servers as the Hub reaches them over its Environment channel. */
const forwardedTarget = (
  forward: EnvironmentExecutor.EnvironmentWorkspaceForward,
): PreviewProxyTarget => {
  // The machine dropped its socket: nothing waits for it to come back.
  const offline = (port: number) => new PreviewProxyError({ reason: "offline", port });
  // A machine from before previews through the Hub would not know the operations.
  const outdated = (port: number) =>
    forward.contractVersion() < PREVIEW_PROXY_CONTRACT_VERSION
      ? new PreviewProxyError({ reason: "outdated", port })
      : undefined;
  return {
    http: (request) => {
      const old = outdated(request.port);
      return old !== undefined
        ? Stream.fail(old)
        : forward
            .stream("preview.proxyHttp", request)
            .pipe(
              Stream.catchTag("EnvironmentExecutorUnavailableError", () =>
                Stream.fail(offline(request.port)),
              ),
            );
    },
    socket: (request) => {
      const old = outdated(request.port);
      return old !== undefined
        ? Stream.fail(old)
        : forward
            .stream("preview.proxySocket", request)
            .pipe(
              Stream.catchTag("EnvironmentExecutorUnavailableError", () =>
                Stream.fail(offline(request.port)),
              ),
            );
    },
    send: (input) =>
      forward.call("preview.proxySocketSend", input).pipe(
        Effect.catchTags({
          EnvironmentExecutorUnavailableError: () => Effect.fail(offline(0)),
        }),
      ),
  };
};

/** The TCP ports this process listens on (Linux), from `/proc`. */
const ownListeningPorts = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const inodes = new Set<string>();
  for (const fd of yield* fs.readDirectory("/proc/self/fd")) {
    const link = yield* fs.readLink(`/proc/self/fd/${fd}`).pipe(Effect.orElseSucceed(() => ""));
    const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
    if (inode !== undefined) inodes.add(inode);
  }
  const ports = new Set<number>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = yield* fs.readFileString(table).pipe(Effect.orElseSucceed(() => ""));
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      // `0A` is LISTEN; the local address is `ADDR:PORT` in hex.
      if (fields[3] !== "0A" || fields[9] === undefined || !inodes.has(fields[9])) continue;
      const port = Number.parseInt(fields[1]?.split(":")[1] ?? "", 16);
      if (Number.isInteger(port)) ports.add(port);
    }
  }
  return ports;
}).pipe(Effect.orElseSucceed(() => new Set<number>()));

export interface HubPreviewsOptions {
  /** How often a live socket's access is checked again, besides on access changes. */
  readonly recheckEvery?: Duration.Input;
}

const makeWith = Effect.fn("HubPreviews.make")(function* (options: HubPreviewsOptions = {}) {
  const sessions = yield* SessionStore.SessionStore;
  const users = yield* UserDirectory.UserDirectory;
  const spaces = yield* SpaceDirectory.SpaceDirectory;
  const spaceVisibility = yield* SpaceVisibility.SpaceVisibility;
  const executors = yield* EnvironmentExecutor.EnvironmentExecutorRegistry;
  const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  // Starts a stopped Sandbox and keeps it from idling; absent without a Sandbox runtime.
  const demand = yield* Effect.serviceOption(EnvironmentDemand.EnvironmentDemand);
  const recheckEvery = options.recheckEvery ?? "30 seconds";
  if (config.previewOrigin === undefined && config.joinedHub === undefined) {
    yield* Effect.logInfo(
      "Previews are served sandboxed at /preview/<token>/ on the Hub's origin: dev servers that use fetch() or ES modules (Vite) do not work there. Set T3CODE_PREVIEW_ORIGIN (https://*.<preview domain>) to give each preview an origin of its own.",
    );
  }
  // Sandboxes of the process runtime share the Hub's loopback: none may reach a port of the Hub.
  const sandboxRuntime = yield* Config.String("T3CODE_SANDBOX_RUNTIME").pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const sharesHubLoopback = Option.getOrUndefined(sandboxRuntime) === "process";
  const declaredHubPorts = new Set<number>(
    [config.port, config.devUrl === undefined ? undefined : Number(config.devUrl.port)].filter(
      (port): port is number => port !== undefined && Number.isInteger(port) && port > 0,
    ),
  );
  let listening: { readonly at: number; readonly ports: ReadonlySet<number> } | undefined;
  const isHubPort = Effect.fn("HubPreviews.isHubPort")(function* (port: number) {
    if (declaredHubPorts.has(port)) return true;
    if (!sharesHubLoopback) return false;
    const now = yield* Clock.currentTimeMillis;
    if (listening === undefined || now - listening.at > 5_000) {
      listening = {
        at: now,
        ports: yield* ownListeningPorts.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        ),
      };
    }
    return listening.ports.has(port);
  });

  const ownerId = users.ownerId().pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  /** The User a principal acts as: itself, or the Owner for one without a User (spec 1). */
  const principalOf = Effect.fn("HubPreviews.principalOf")(function* (userId: UserId | undefined) {
    return userId ?? (yield* ownerId);
  });

  // In least-recently-used order: a Map keeps insertion order, and a use re-inserts.
  const addresses = new Map<string, PreviewAddress>();
  const byKey = new Map<string, string>();
  const byOrigin = new Map<string, string>();
  // Handoff codes into a preview's own origin, by code; indexed by address and by User (oldest
  // first), so dropping an address's or capping a User's never scans everyone's.
  interface Handoff {
    readonly token: string;
    readonly principal: string;
    readonly expiresAtMillis: number;
  }
  const handoffs = new Map<string, Handoff>();
  const handoffsByToken = new Map<string, Set<string>>();
  const handoffsByPrincipal = new Map<string, Set<string>>();
  const dropHandoff = (code: string) => {
    const pending = handoffs.get(code);
    if (pending === undefined) return;
    handoffs.delete(code);
    handoffsByToken.get(pending.token)?.delete(code);
    if (handoffsByToken.get(pending.token)?.size === 0) handoffsByToken.delete(pending.token);
    handoffsByPrincipal.get(pending.principal)?.delete(code);
    if (handoffsByPrincipal.get(pending.principal)?.size === 0) {
      handoffsByPrincipal.delete(pending.principal);
    }
  };
  const keyOf = (
    address: Omit<PreviewAddress, "token" | "pass" | "originId" | "expiresAtMillis">,
  ) =>
    JSON.stringify([
      address.principal,
      address.sessionId,
      address.threadId,
      address.environmentId,
      address.port,
    ]);
  const checks = new Map<
    string,
    { readonly at: number; readonly revision: number; readonly checked: Checked }
  >();
  const forget = (token: string) => {
    const address = addresses.get(token);
    checks.delete(token);
    if (address === undefined) return;
    addresses.delete(token);
    byOrigin.delete(address.originId);
    const key = keyOf(address);
    if (byKey.get(key) === token) byKey.delete(key);
    for (const code of handoffsByToken.get(token) ?? []) dropHandoff(code);
  };
  const touch = (address: PreviewAddress, now: number) => {
    address.expiresAtMillis = now + PREVIEW_ADDRESS_IDLE_TTL_MS;
    addresses.delete(address.token);
    addresses.set(address.token, address);
  };

  // A session that ends takes its addresses with it.
  yield* sessions.streamChanges.pipe(
    Stream.runForEach((change) =>
      Effect.sync(() => {
        if (change.type !== "clientRemoved") return;
        for (const [token, address] of addresses) {
          if (address.sessionId === change.sessionId) forget(token);
        }
      }),
    ),
    Effect.forkScoped,
  );

  /**
   * Where the address leads now, if its User may still go there. `environmentId` is the
   * Thread's Active environment as just read.
   */
  const check = Effect.fn("HubPreviews.check")(function* (
    address: Omit<PreviewAddress, "token" | "pass" | "originId" | "expiresAtMillis">,
    environmentId: EnvironmentId,
  ): Effect.fn.Return<Checked> {
    // An address is for one machine: the Thread moved, so its dev servers are elsewhere.
    if (environmentId !== address.environmentId) return REFUSED;
    // The Hub machine's loopback is the Hub's own: its ports and internals are no preview.
    if (environmentId === HUB_MACHINE_ENVIRONMENT_ID) return REFUSED;
    if (yield* isHubPort(address.port)) return REFUSED;
    const session = yield* sessions
      .getActive(address.sessionId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(session)) return REFUSED;
    // The rule of every preview RPC: the User's own Thread, in a Space they still belong to.
    const visibility = yield* spaceVisibility.of(address.principal);
    const work = yield* spaceVisibility.claimWork(visibility, address.principal, address.threadId, {
      drafts: false,
    });
    if (work !== "allowed") return REFUSED;
    if (environmentId === EnvironmentExecutor.NO_ENVIRONMENT_ID) {
      return { _tag: "offline", name: undefined };
    }
    const usable = yield* environments
      .usableBy({ userId: address.principal, environmentId, threadId: address.threadId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(usable)) return REFUSED;
    if (Option.isSome(demand)) {
      // Opening a preview is the User's own action: a stopped Sandbox starts for it.
      const started = yield* demand.value
        .awaitStarted(environmentId, { actorUserId: address.principal, explicit: true })
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("A Sandbox did not start for a preview", {
              environmentId,
              detail: error.detail,
            }).pipe(Effect.as(false)),
          ),
        );
      if (!started) return { _tag: "offline", name: usable.value.name };
    }
    const executor = yield* Effect.option(executors.get(environmentId));
    const forward = Option.flatMap(executor, (found) => found.workspace.forward);
    if (Option.isNone(forward)) return { _tag: "offline", name: usable.value.name };
    return { _tag: "open", target: forwardedTarget(forward.value), name: usable.value.name };
  });

  /** `check`, answered from the last few seconds unless a Space or Membership changed. */
  const checkCached = Effect.fn("HubPreviews.checkCached")(function* (address: PreviewAddress) {
    // Read every time: a move ends the address at once.
    const environmentId = yield* executors.activeEnvironment(address.threadId);
    if (environmentId !== address.environmentId) return REFUSED;
    const now = yield* Clock.currentTimeMillis;
    const revision = yield* spaces.revision;
    const cached = checks.get(address.token);
    if (cached !== undefined && cached.revision === revision && now - cached.at < CHECK_CACHE_MS) {
      return cached.checked;
    }
    const checked = yield* check(address, environmentId);
    checks.set(address.token, { at: now, revision, checked });
    return checked;
  });

  const address: HubPreviews["Service"]["address"] = Effect.fn("HubPreviews.address")(
    function* (input) {
      const principal = yield* principalOf(input.userId);
      const environmentId = yield* executors.activeEnvironment(input.threadId);
      const refuse = (checked: Exclude<Checked, { readonly _tag: "open" }>) =>
        new PreviewEnvironmentUnavailableError({
          threadId: input.threadId,
          reason: checked._tag === "offline" ? "environment_offline" : "outside_thread_workspace",
          ...(checked._tag === "offline" && checked.name !== undefined
            ? { environmentName: checked.name }
            : {}),
        });
      const wanted = { ...input, principal, environmentId };
      const checked = yield* check(wanted, environmentId);
      if (checked._tag !== "open") return yield* refuse(checked);
      const now = yield* Clock.currentTimeMillis;
      const key = keyOf(wanted);
      const known = byKey.get(key);
      const kept = known === undefined ? undefined : addresses.get(known);
      let made: PreviewAddress;
      if (kept !== undefined && kept.expiresAtMillis > now) {
        made = kept;
      } else {
        if (known !== undefined) forget(known);
        // This User's own least recently used ones make room; nobody else's.
        const theirs = [...addresses.values()].filter((address) => address.principal === principal);
        for (const old of theirs) {
          if (old.expiresAtMillis > now && theirs.length < MAX_ADDRESSES_PER_USER) break;
          forget(old.token);
          theirs.shift();
        }
        made = {
          ...wanted,
          token: randomToken(),
          pass: randomToken(),
          originId: newPreviewId(),
          expiresAtMillis: now,
        };
        byKey.set(key, made.token);
        byOrigin.set(made.originId, made.token);
      }
      touch(made, now);
      const path = `${HUB_PREVIEW_ROUTE_PREFIX}/${made.token}/`;
      return {
        path,
        ...(config.publicUrl === undefined
          ? {}
          : { url: new URL(path, config.publicUrl.origin).href }),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(made.expiresAtMillis)),
      };
    },
  );

  /** A request whose credential matched `known`: the address's rule, checked as it comes. */
  const serve = Effect.fn("HubPreviews.serve")(function* (
    known: PreviewAddress,
  ): Effect.fn.Return<PreviewResolution> {
    const now = yield* Clock.currentTimeMillis;
    const checked = yield* checkCached(known);
    if (checked._tag !== "open") return checked;
    touch(known, now);
    // Each request served is use: the Sandbox's idle time starts again.
    if (Option.isSome(demand)) yield* demand.value.touch(known.environmentId);
    return { _tag: "open", address: known, target: checked.target, name: checked.name };
  });

  /** The live address under `token`, forgetting it once it lapsed. */
  const live = Effect.fn("HubPreviews.live")(function* (token: string | undefined) {
    const known = token === undefined ? undefined : addresses.get(token);
    if (known === undefined) return undefined;
    if (known.expiresAtMillis <= (yield* Clock.currentTimeMillis)) {
      forget(known.token);
      return undefined;
    }
    return known;
  });

  const resolve: HubPreviews["Service"]["resolve"] = Effect.fn("HubPreviews.resolve")(
    function* (token, credentials) {
      const known = yield* live(token);
      if (known === undefined) return REFUSED;
      if (Option.isSome(credentials.hubUser)) {
        // Someone else's Hub session: another User opened this User's link.
        if ((yield* principalOf(credentials.hubUser.value)) !== known.principal) return REFUSED;
      } else if (Option.isNone(credentials.pass) || credentials.pass.value !== known.pass) {
        // The address alone is not enough: a leaked link opens nothing.
        return { _tag: "unauthenticated" } as const;
      }
      return yield* serve(known);
    },
  );

  const resolveOrigin: HubPreviews["Service"]["resolveOrigin"] = Effect.fn(
    "HubPreviews.resolveOrigin",
  )(function* (originId, pass) {
    const known = yield* live(byOrigin.get(originId));
    if (known === undefined) return REFUSED;
    // Only this origin's own cookie: a host-only one the handoff set, for this address alone.
    if (Option.isNone(pass) || pass.value !== known.pass) {
      return { _tag: "unauthenticated" } as const;
    }
    return yield* serve(known);
  });

  const handoff: HubPreviews["Service"]["handoff"] = Effect.fn("HubPreviews.handoff")(
    function* (address) {
      const now = yield* Clock.currentTimeMillis;
      const principal = String(address.principal ?? "");
      const theirs = handoffsByPrincipal.get(principal) ?? new Set<string>();
      // This User's own lapsed ones go, then their oldest past the cap; nobody else's.
      for (const code of theirs) {
        const pending = handoffs.get(code);
        if (pending === undefined || pending.expiresAtMillis <= now) dropHandoff(code);
      }
      for (const code of theirs) {
        if (theirs.size < MAX_HANDOFFS_PER_USER) break;
        dropHandoff(code);
      }
      const code = randomToken();
      handoffs.set(code, {
        token: address.token,
        principal,
        expiresAtMillis: now + PREVIEW_HANDOFF_TTL_MS,
      });
      handoffsByToken.set(
        address.token,
        (handoffsByToken.get(address.token) ?? new Set()).add(code),
      );
      handoffsByPrincipal.set(principal, theirs.add(code));
      return code;
    },
  );

  const redeemHandoff: HubPreviews["Service"]["redeemHandoff"] = Effect.fn(
    "HubPreviews.redeemHandoff",
  )(function* (originId, code) {
    const pending = handoffs.get(code);
    // Spent on its first presentation, whatever comes of it.
    dropHandoff(code);
    if (pending === undefined || pending.expiresAtMillis <= (yield* Clock.currentTimeMillis)) {
      return Option.none();
    }
    const known = yield* live(pending.token);
    return known !== undefined && known.originId === originId ? Option.some(known) : Option.none();
  });

  const whileAllowed: HubPreviews["Service"]["whileAllowed"] = (address) =>
    Effect.scoped(
      Effect.gen(function* () {
        // An open preview socket keeps its Sandbox from idling until it closes.
        if (Option.isSome(demand)) yield* demand.value.hold(address.environmentId);
        const changes = yield* spaceVisibility.subscribeAccessChanges(address.principal);
        const stillAllowed = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (addresses.get(address.token) !== address || address.expiresAtMillis <= now) {
            return false;
          }
          const environmentId = yield* executors.activeEnvironment(address.threadId);
          return (yield* check(address, environmentId))._tag !== "refused";
        });
        // Checked on every access change, and every `recheckEvery` for what sends none (moves).
        const lost = Stream.merge(
          changes,
          Stream.fromSchedule(Schedule.spaced(recheckEvery)).pipe(Stream.as(undefined)),
        ).pipe(
          Stream.mapEffect(() => stillAllowed),
          Stream.filter((allowed) => !allowed),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* Effect.raceFirst(
          lost,
          sessions.awaitInvalidation(address.sessionId).pipe(Effect.catch(() => Effect.never)),
        );
      }),
    );

  const hubPorts: HubPreviews["Service"]["hubPorts"] = (ports) =>
    Effect.sync(() => {
      for (const port of ports) declaredHubPorts.add(port);
    });

  return HubPreviews.of({
    address,
    resolve,
    resolveOrigin,
    handoff,
    redeemHandoff,
    whileAllowed,
    hubPorts,
  });
});

export const layerWith = (options: HubPreviewsOptions = {}) =>
  Layer.effect(HubPreviews, makeWith(options));

export const layer = layerWith();
