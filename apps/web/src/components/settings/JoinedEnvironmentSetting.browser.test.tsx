import { RegistryContext } from "@effect/atom-react";
import type { DesktopJoinedEnvironmentState } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";
import { JoinedEnvironmentSetting } from "./JoinedEnvironmentSetting";

const HUB = "https://hub.example.com";
const notJoined: DesktopJoinedEnvironmentState = {
  hub: null,
  repair: null,
  enabled: false,
  keepRunningWhenClosed: true,
  process: "stopped",
  connection: null,
  joining: null,
  error: null,
  baseDir: "/home/me/.t3/joined-environment",
};
const running: DesktopJoinedEnvironmentState = {
  ...notJoined,
  hub: { url: HUB, name: "Laptop" },
  enabled: true,
  process: "running",
  connection: { status: "connected", detail: "2026-11-06T10:00:01.000Z" },
};

it("joins a Hub, shows the connection, turns off and leaves", async () => {
  let state = notJoined;
  const answer = (next: DesktopJoinedEnvironmentState) => {
    state = next;
    return Promise.resolve(next);
  };
  const bridge = {
    getJoinedEnvironmentState: vi.fn(() => Promise.resolve(state)),
    joinAsEnvironment: vi.fn((input: { readonly hubUrl: string }) =>
      answer({
        ...notJoined,
        joining: { hubUrl: input.hubUrl, approvalUrl: `${HUB}/register-environment?request=r` },
      }),
    ),
    cancelJoinAsEnvironment: vi.fn(() => answer(notJoined)),
    setJoinedEnvironmentEnabled: vi.fn((enabled: boolean) =>
      answer({
        ...running,
        enabled,
        process: enabled ? "running" : "stopped",
        connection: enabled ? running.connection : null,
      }),
    ),
    setJoinedEnvironmentKeepRunning: vi.fn((keep: boolean) =>
      answer({ ...state, keepRunningWhenClosed: keep }),
    ),
    leaveJoinedEnvironment: vi.fn(() => answer(notJoined)),
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  };
  using _bridge = stubGlobal("desktopBridge", bridge);
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <JoinedEnvironmentSetting />
    </RegistryContext.Provider>,
  );

  const toggle = screen.getByRole("switch", { name: "Use this computer as an Environment" });
  await expect.element(toggle).not.toBeChecked();
  await toggle.click();
  await screen.getByRole("textbox", { name: "Hub address" }).fill(HUB);
  await screen.getByRole("button", { name: "Join" }).click();
  expect(bridge.joinAsEnvironment).toHaveBeenCalledWith({ hubUrl: HUB });
  await expect
    .element(screen.getByText(/Approve this computer on https:\/\/hub\.example\.com/))
    .toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Open it" })).toBeVisible();

  // The Owner approves in the browser; the app starts the joined server.
  state = running;
  await expect.element(screen.getByText("Connected"), { timeout: 6_000 }).toBeVisible();
  await expect.element(screen.getByText(`Laptop on ${HUB}.`)).toBeVisible();

  await screen.getByRole("switch", { name: "Keep running when the window is closed" }).click();
  expect(bridge.setJoinedEnvironmentKeepRunning).toHaveBeenCalledWith(false);

  await toggle.click();
  expect(bridge.setJoinedEnvironmentEnabled).toHaveBeenCalledWith(false);
  await expect.element(screen.getByText(/Turned off/)).toBeVisible();

  await screen.getByRole("button", { name: "Leave" }).click();
  await screen.getByRole("button", { name: "Leave the Hub" }).click();
  expect(bridge.leaveJoinedEnvironment).toHaveBeenCalledOnce();
  await expect.element(toggle).not.toBeChecked();
  await expect.element(screen.getByText(/Run your Hub's Threads on this computer/)).toBeVisible();
});

it("offers Join again and Leave for an unreadable joined-hub.json, and keeps a failed Leave open", async () => {
  const repair =
    "/home/me/.t3/joined-environment/userdata/joined-hub.json is unreadable, so this computer's Environment server does not start. Join again to replace it, or Leave to forget it.";
  const bridge = {
    getJoinedEnvironmentState: vi.fn(() => Promise.resolve({ ...notJoined, repair })),
    joinAsEnvironment: vi.fn(),
    cancelJoinAsEnvironment: vi.fn(),
    setJoinedEnvironmentEnabled: vi.fn(),
    setJoinedEnvironmentKeepRunning: vi.fn(),
    leaveJoinedEnvironment: vi.fn(() =>
      Promise.reject(new Error("This computer's Environment server (process 42) did not stop.")),
    ),
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  };
  using _bridge = stubGlobal("desktopBridge", bridge);
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <JoinedEnvironmentSetting />
    </RegistryContext.Provider>,
  );

  await expect.element(screen.getByText(/is unreadable/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Join again" })).toBeVisible();
  await screen.getByRole("button", { name: "Leave" }).click();
  await screen.getByRole("button", { name: "Leave the Hub" }).click();
  expect(bridge.leaveJoinedEnvironment).toHaveBeenCalledOnce();
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await expect.element(screen.getByRole("dialog").getByText(/did not stop/)).toBeVisible();
});
