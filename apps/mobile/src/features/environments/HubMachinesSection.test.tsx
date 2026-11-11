import { EnvironmentId, type HubEnvironmentOverviewEntry, SpaceId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    isOwner: false,
    overview: vi.fn(),
    environments: [] as ReadonlyArray<HubEnvironmentOverviewEntry>,
  },
}));

vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: ({ title, children }: { title: string; children?: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label }: { label: string }) => <button>{label}</button>,
}));
vi.mock("./EnvironmentStatusDot", () => ({
  EnvironmentStatusDot: ({ status }: { status: string }) => <i data-status={status} />,
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useHubConnection: () => ({
    environmentId: "hub",
    httpBaseUrl: "http://hub.test",
    bearerToken: "token",
  }),
}));
vi.mock("../../state/spaces", () => ({
  useSpaceSelections: () => new Map([["hub", { view: { isOwner: mocks.isOwner } }]]),
}));
vi.mock("../../state/hubEnvironmentOverview", () => ({
  useHubEnvironmentOverview: (connection: unknown) => {
    mocks.overview(connection);
    return { environments: mocks.environments, failed: false, refresh: () => {} };
  },
}));

import { HubMachinesSection } from "./HubMachinesSection";

const acme = SpaceId.make("space-acme");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.overview.mockClear();
  mocks.environments = [
    {
      id: EnvironmentId.make("sandbox:space-acme"),
      name: "Acme Sandbox",
      kind: "sandbox",
      mode: "sandbox",
      spaceId: acme,
      spaceName: "Acme",
      ownerUserId: null,
      ownerName: null,
      status: "failed",
      startError: "Podman is not installed",
      os: null,
      lastSeenAt: null,
      runningThreadCount: 0,
    },
    {
      id: EnvironmentId.make("env-vps"),
      name: "Acme VPS",
      kind: "external",
      mode: "dedicated",
      spaceId: acme,
      spaceName: "Acme",
      ownerUserId: null,
      ownerName: null,
      status: "online",
      startError: null,
      os: "linux",
      lastSeenAt: null,
      runningThreadCount: 1,
    },
  ];
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("HubMachinesSection", () => {
  it("shows the Owner every machine with its mode, Space and state, to read only", () => {
    mocks.isOwner = true;
    act(() => root?.render(<HubMachinesSection />));
    expect(mocks.overview).toHaveBeenCalledWith(
      expect.objectContaining({ httpBaseUrl: "http://hub.test", bearerToken: "token" }),
    );
    const section = container?.querySelector('section[aria-label="Machines on this Hub"]');
    expect(section).not.toBeNull();
    expect(
      container?.querySelector('[aria-label="Acme Sandbox, Failed to start · Sandbox of Acme"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector(
        '[aria-label="Acme VPS, Online · Dedicated to Acme · linux · 1 running Thread"]',
      ),
    ).not.toBeNull();
    expect(container?.textContent).toContain("Podman is not installed");
    expect(container?.textContent).toContain("Dedicated machine");
    expect(container?.querySelectorAll("[data-status]")).toHaveLength(2);
    // Read-only: no action on any machine.
    expect(container?.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows nothing to anyone else, and never asks the Owner-only endpoint", () => {
    mocks.isOwner = false;
    act(() => root?.render(<HubMachinesSection />));
    expect(container?.innerHTML).toBe("");
    expect(mocks.overview).not.toHaveBeenCalled();
  });
});
