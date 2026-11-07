import { describe, expect, it } from "@effect/vitest";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
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
import { SINGLE_HUB_REFUSAL, keptSavedConnections } from "./singleHub";
import { layer } from "./storage";

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

function memoryStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
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

describe("mobile connects one Hub", () => {
  it.effect(
    "connects the saved Hub that answers for itself, keeps the others saved, and refuses a second Hub",
    () =>
      Effect.gen(function* () {
        // The paired server answers as some other machine; the Hub answers for itself.
        vi.stubGlobal(
          "fetch",
          vi.fn(async (url: URL) => ({
            ok: true,
            json: async () => ({
              environmentId: url.hostname.startsWith("hub.") ? "hub" : "someone-else",
            }),
          })),
        );
        const storage = memoryStorage({
          [LEGACY_CONNECTIONS_KEY]: JSON.stringify({
            connections: [legacy("paired-server"), legacy("hub"), legacy("old-hub")],
          }),
        });
        const context = yield* Layer.build(
          layer.pipe(
            Layer.provide(Layer.succeed(MobileSecureStorage.MobileSecureStorage, storage)),
          ),
        );
        const targets = Persistence.ConnectionTargetStore;
        const registrations = Persistence.ConnectionRegistrationStore;
        const listed = yield* Effect.flatMap(targets, (store) => store.list).pipe(
          Effect.provide(context),
        );
        expect(listed.map((target) => target.environmentId)).toEqual(["hub"]);
        expect(keptSavedConnections.count()).toBe(2);
        expect(keptSavedConnections.connected()).toBe("hub");

        const refused = yield* Effect.flatMap(registrations, (store) =>
          store.register(registration("another-hub"), [registration("another-hub").target]),
        ).pipe(Effect.provide(context), Effect.flip);
        expect(refused.message).toBe(SINGLE_HUB_REFUSAL);

        // A new credential for the connected Hub is still saved.
        yield* Effect.flatMap(registrations, (store) =>
          store.register(registration("hub"), [registration("hub").target]),
        ).pipe(Effect.provide(context));

        // Removing it frees the slot for another Hub.
        yield* Effect.flatMap(registrations, (store) =>
          store.remove(EnvironmentId.make("hub")),
        ).pipe(Effect.provide(context));
        expect(keptSavedConnections.connected()).toBeNull();
        yield* Effect.flatMap(registrations, (store) =>
          store.register(registration("another-hub"), [registration("another-hub").target]),
        ).pipe(Effect.provide(context));
        expect(keptSavedConnections.connected()).toBe("another-hub");
      }).pipe(Effect.scoped),
  );
});
