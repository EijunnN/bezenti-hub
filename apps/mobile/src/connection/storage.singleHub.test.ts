import { describe, expect, it } from "@effect/vitest";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import * as MobileSecureStorage from "../persistence/mobile-secure-storage";
import { LEGACY_CONNECTIONS_KEY } from "./catalog-store";
import {
  KEPT_CONNECTION_REFUSAL,
  SINGLE_HUB_REFUSAL,
  chooseKeptAsHub,
  hubState,
} from "./singleHub";
import { HUB_CHOICE_KEY, layer } from "./storage";

const legacy = (id: string) => ({
  environmentId: id,
  environmentLabel: id,
  pairingUrl: `https://${id}.example.test/pair`,
  displayUrl: `https://${id}.example.test`,
  httpBaseUrl: `https://${id}.example.test`,
  wsBaseUrl: `wss://${id}.example.test`,
  bearerToken: `${id}-token`,
  authenticationMethod: "bearer",
});

function memoryStorage(values: Map<string, string>) {
  return MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  });
}

const registration = (id: string) => {
  const environmentId = EnvironmentId.make(id);
  const connectionId = `bearer:${id}`;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({ environmentId, label: id, connectionId }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId,
      label: id,
      httpBaseUrl: `https://${id}.example.test`,
      wsBaseUrl: `wss://${id}.example.test`,
    }),
    credential: new BearerConnectionCredential({ token: `${id}-token` }),
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const answersAsHub = (hubs: ReadonlyArray<string>) => {
  const fetch = vi.fn(async (url: URL) => ({
    ok: true,
    json: async () => ({
      environmentId: hubs.find((id) => url.hostname.startsWith(`${id}.`)) ?? "someone-else",
    }),
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

/** One app start: the storage layer over the phone's secure storage. */
const start = (values: Map<string, string>) =>
  Layer.build(
    layer.pipe(
      Layer.provide(Layer.succeed(MobileSecureStorage.MobileSecureStorage, memoryStorage(values))),
    ),
  );

const listed = (context: Context.Context<Persistence.ConnectionTargetStore>) =>
  Effect.flatMap(Persistence.ConnectionTargetStore, (store) => store.list).pipe(
    Effect.provide(context),
    Effect.map((targets) => targets.map((target) => target.environmentId)),
  );

const register = (context: Context.Context<Persistence.ConnectionRegistrationStore>, id: string) =>
  Effect.flatMap(Persistence.ConnectionRegistrationStore, (store) =>
    store.register(registration(id), [registration(id).target]),
  ).pipe(Effect.provide(context));

const remove = (context: Context.Context<Persistence.ConnectionRegistrationStore>, id: string) =>
  Effect.flatMap(Persistence.ConnectionRegistrationStore, (store) =>
    store.remove(EnvironmentId.make(id)),
  ).pipe(Effect.provide(context));

const legacyPhone = () =>
  new Map([
    [
      LEGACY_CONNECTIONS_KEY,
      JSON.stringify({
        connections: [legacy("paired-server"), legacy("hub"), legacy("old-hub")],
      }),
    ],
  ]);

describe("mobile connects one Hub", () => {
  it.effect("decides the Hub once, stores it, and never probes again", () =>
    Effect.gen(function* () {
      const values = legacyPhone();
      const fetch = answersAsHub(["hub"]);
      expect(yield* listed(yield* start(values))).toEqual(["hub"]);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(JSON.parse(values.get(HUB_CHOICE_KEY)!)).toEqual({ hub: "hub" });
      expect(hubState.get().kept.map((entry) => entry.environmentId)).toEqual([
        "paired-server",
        "old-hub",
      ]);

      // The next start connects the stored Hub, even if another one answers now.
      const later = answersAsHub(["old-hub"]);
      expect(yield* listed(yield* start(values))).toEqual(["hub"]);
      expect(later).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a second Hub and a kept connection, even re-registered", () =>
    Effect.gen(function* () {
      const values = legacyPhone();
      answersAsHub(["hub"]);
      const context = yield* start(values);
      yield* listed(context);
      expect((yield* Effect.flip(register(context, "another-hub"))).message).toBe(
        SINGLE_HUB_REFUSAL,
      );
      expect((yield* Effect.flip(register(context, "old-hub"))).message).toBe(SINGLE_HUB_REFUSAL);
      // A new credential for the Hub itself is still saved.
      yield* register(context, "hub");
    }).pipe(Effect.scoped),
  );

  it.effect("after the Hub is removed, only a new Hub or an explicit choice connects", () =>
    Effect.gen(function* () {
      const values = legacyPhone();
      answersAsHub(["hub"]);
      const context = yield* start(values);
      yield* listed(context);
      yield* remove(context, "hub");
      expect(hubState.get().hub).toBeNull();
      expect(JSON.parse(values.get(HUB_CHOICE_KEY)!)).toEqual({ hub: null });
      // Kept connections never connect on their own, not at the next start either.
      expect((yield* Effect.flip(register(context, "old-hub"))).message).toBe(
        KEPT_CONNECTION_REFUSAL,
      );
      const probe = answersAsHub(["old-hub"]);
      expect(yield* listed(yield* start(values))).toEqual([]);
      expect(probe).not.toHaveBeenCalled();

      // «Use as my Hub» makes the kept one the Hub, stored.
      chooseKeptAsHub(EnvironmentId.make("old-hub"));
      yield* register(context, "old-hub");
      expect(hubState.get().hub).toBe("old-hub");
      expect(yield* listed(yield* start(values))).toEqual(["old-hub"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a new Hub added after removing the old one becomes the stored Hub", () =>
    Effect.gen(function* () {
      const values = legacyPhone();
      answersAsHub(["hub"]);
      const context = yield* start(values);
      yield* listed(context);
      yield* remove(context, "hub");
      yield* register(context, "new-hub");
      expect(JSON.parse(values.get(HUB_CHOICE_KEY)!)).toEqual({ hub: "new-hub" });
      expect(yield* listed(yield* start(values))).toEqual(["new-hub"]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps everything unconnected when no saved connection answers as a Hub", () =>
    Effect.gen(function* () {
      const values = legacyPhone();
      answersAsHub([]);
      expect(yield* listed(yield* start(values))).toEqual([]);
      expect(values.has(HUB_CHOICE_KEY)).toBe(false);
      expect(hubState.get()).toMatchObject({ hub: null });
      expect(hubState.get().kept).toHaveLength(3);
    }).pipe(Effect.scoped),
  );
});
