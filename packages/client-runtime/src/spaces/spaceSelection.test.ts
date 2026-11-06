import { EnvironmentId, type SpaceDirectoryView, SpaceId, UserId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { currentSpaceFor } from "./currentSpace.ts";
import { makeSpaceSelectionStore } from "./spaceSelection.ts";

const hub = EnvironmentId.make("hub-1");
const personal = SpaceId.make("personal:grace");
const acme = SpaceId.make("org-acme");

const view = (userId: string, canCreatePersonal = false): SpaceDirectoryView => ({
  userId: UserId.make(userId),
  personalSpaceId: personal,
  canCreateOrganization: false,
  spaces: [
    {
      id: personal,
      kind: "personal",
      name: "Personal",
      role: null,
      isOwn: true,
      canCreateThreads: canCreatePersonal,
      canInvite: false,
    },
    {
      id: acme,
      kind: "organization",
      name: "Acme",
      role: "member",
      isOwn: false,
      canCreateThreads: true,
      canInvite: false,
    },
  ],
});

it("keeps each environment's User and current Space, and stamps new work with it", () => {
  const stored = new Map<string, string>();
  const store = makeSpaceSelectionStore({
    read: (key) => stored.get(key) ?? null,
    write: (key, value) => void stored.set(key, value),
  });

  // The first Space the User can create in, since nothing was chosen yet.
  store.apply(hub, { _tag: "loaded", view: view("grace") });
  expect(store.get(hub)).toMatchObject({ currentSpaceId: acme, loadFailed: false });
  expect(currentSpaceFor(hub)).toBe(acme);

  store.select(hub, personal);
  expect(currentSpaceFor(hub)).toBe(personal);
  // A failed refresh keeps the Spaces and the choice.
  store.apply(hub, { _tag: "failed" });
  expect(store.get(hub)).toMatchObject({ currentSpaceId: personal, loadFailed: true });
  // A Space the directory does not list cannot be chosen.
  store.select(hub, SpaceId.make("org-other"));
  expect(currentSpaceFor(hub)).toBe(personal);

  // Another User on the same Hub starts from their own stored choice, not Grace's.
  store.apply(hub, { _tag: "loaded", view: view("linus") });
  expect(store.get(hub).currentSpaceId).toBe(acme);
  // Grace's choice outlives a restart.
  const restarted = makeSpaceSelectionStore({
    read: (key) => stored.get(key) ?? null,
    write: () => undefined,
  });
  restarted.apply(hub, { _tag: "loaded", view: view("grace") });
  expect(restarted.get(hub).currentSpaceId).toBe(personal);

  // A session without a User has no Spaces; the server picks where things go.
  restarted.apply(hub, { _tag: "no-user" });
  expect(restarted.get(hub)).toEqual({ view: null, currentSpaceId: null, loadFailed: false });
  expect(currentSpaceFor(hub)).toBeUndefined();
});
