import {
  EnvironmentId,
  HUB_MACHINE_ENVIRONMENT_ID,
  type HubEnvironmentList,
  type HubEnvironmentSummary,
  type OrchestrationV2ThreadMove,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  activeEnvironmentLabel,
  activeEnvironmentOf,
  makeHubEnvironmentsPoller,
  moveCandidates,
  moveProgressView,
  threadEnvironmentState,
} from "./hubEnvironments.ts";

const laptopId = EnvironmentId.make("env-laptop");

const environment = (
  overrides: Partial<HubEnvironmentSummary> & Pick<HubEnvironmentSummary, "id" | "name">,
): HubEnvironmentSummary => ({
  kind: "external",
  mode: "personal",
  ownerUserId: null,
  status: "online",
  registeredAt: "2026-11-01T00:00:00.000Z",
  lastSeenAt: null,
  os: null,
  hostname: null,
  providers: [],
  resources: null,
  runningThreadCount: 0,
  ...overrides,
});

const hub = environment({ id: HUB_MACHINE_ENVIRONMENT_ID, name: "Hub machine", kind: "hub" });
const laptop = environment({ id: laptopId, name: "Laptop", status: "offline" });

// Lets settled fetches reach the poller: a few microtask turns, no clock.
const flush = async () => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe("makeHubEnvironmentsPoller", () => {
  it("reads while subscribed, notifies only on a change, and forgets on reset", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let answer: HubEnvironmentList = { environments: [hub] };
      const fetch = vi.fn(() => Promise.resolve(answer));
      const poller = makeHubEnvironmentsPoller({ fetch, intervalMs: 1000 });
      const listener = vi.fn();
      const unsubscribe = poller.subscribe(listener);
      await flush();
      expect(poller.snapshot()).toEqual([hub]);
      expect(listener).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1000);
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledTimes(1);

      answer = { environments: [hub, laptop] };
      vi.advanceTimersByTime(1000);
      await flush();
      expect(poller.snapshot()).toEqual([hub, laptop]);
      expect(listener).toHaveBeenCalledTimes(2);

      poller.reset();
      expect(poller.snapshot()).toEqual([]);
      expect(listener).toHaveBeenCalledTimes(3);

      unsubscribe();
      vi.advanceTimersByTime(5000);
      await flush();
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the last list when a read fails and drops an answer that started before a reset", async () => {
    let resolveSlow: (list: HubEnvironmentList) => void = () => undefined;
    const fetch = vi
      .fn<() => Promise<HubEnvironmentList>>()
      .mockResolvedValueOnce({ environments: [hub] })
      .mockRejectedValueOnce(new Error("signed out"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          }),
      );
    const poller = makeHubEnvironmentsPoller({ fetch });
    const unsubscribe = poller.subscribe(() => undefined);
    await flush();
    poller.refresh();
    await flush();
    expect(poller.snapshot()).toEqual([hub]);

    poller.refresh();
    poller.reset();
    resolveSlow({ environments: [hub, laptop] });
    await flush();
    expect(poller.snapshot()).toEqual([]);
    unsubscribe();
  });
});

describe("a Thread's Active environment", () => {
  it("names the machine and its live status, the Hub machine always online", () => {
    const offline = activeEnvironmentOf([hub, laptop], laptopId);
    expect(offline).toEqual({
      name: "Laptop",
      status: "offline",
      isHubMachine: false,
      needsEnvironment: false,
    });
    expect(activeEnvironmentLabel(offline!)).toBe("Laptop, offline");
    expect(activeEnvironmentOf([hub, laptop], undefined)?.name).toBe("Hub machine");
    expect(activeEnvironmentOf([hub], laptopId)).toBeNull();
  });

  it("needs an environment once its machine was removed, and pauses a turn on one offline", () => {
    const removed = activeEnvironmentOf([hub], null);
    expect(threadEnvironmentState(removed, false)).toBe("needs-environment");
    expect(activeEnvironmentLabel(removed!)).toBe("needs an environment");
    const offline = activeEnvironmentOf([hub, laptop], laptopId);
    expect(threadEnvironmentState(offline, true)).toBe("paused-offline");
    expect(threadEnvironmentState(offline, false)).toBeNull();
    expect(threadEnvironmentState(activeEnvironmentOf([hub], undefined), true)).toBeNull();
  });
});

describe("moving a Thread", () => {
  it("offers every machine but the source; a Thread with none may go to any", () => {
    expect(moveCandidates([hub, laptop], undefined)).toEqual([laptop]);
    expect(moveCandidates([hub, laptop], laptopId)).toEqual([hub]);
    expect(moveCandidates([hub, laptop], null)).toEqual([hub, laptop]);
  });

  const move = (overrides: Partial<OrchestrationV2ThreadMove>): OrchestrationV2ThreadMove => ({
    id: "move-1",
    sourceEnvironmentId: HUB_MACHINE_ENVIRONMENT_ID,
    targetEnvironmentId: laptopId,
    ifRunning: "wait",
    step: "fetching",
    status: "running",
    startedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  });

  it("shows each step's state while it runs", () => {
    const view = moveProgressView(move({}), "Hub machine", "Laptop");
    expect(view.summary).toBe("Moving to Laptop: Fetching the checkpoint");
    expect(view.steps.map((step) => step.state)).toEqual([
      "done",
      "done",
      "current",
      "pending",
      "pending",
      "pending",
    ]);
    expect(view.failure).toBeNull();
  });

  it("says where a failed move stopped and that the Thread stays", () => {
    const view = moveProgressView(
      move({
        status: "failed",
        step: "preparing",
        failure: { step: "preparing", message: "setup script exited 1" },
        sourceOffline: true,
        continuesFrom: { kind: "uploaded", appRunOrdinal: 3 } as never,
      }),
      "Hub machine",
      "Laptop",
    );
    expect(view.summary).toBe(
      "The move stopped at «Preparing the workspace». The Thread stays on Hub machine.",
    );
    expect(view.steps[3]?.state).toBe("failed");
    expect(view.steps[1]?.label).toBe(
      "Uploading a final checkpoint (skipped: Hub machine was offline)",
    );
    expect(view.failure).toBe("setup script exited 1");
    expect(view.continuesFrom).toContain("checkpoint of turn 3");
  });

  it("says a waiting move waits on the User's answer", () => {
    expect(
      moveProgressView(
        move({ step: "waiting-for-turn", waitingOn: "user" }),
        "Hub machine",
        "Laptop",
      ).summary,
    ).toBe("Moving to Laptop: Waiting for your answer in the running turn");
  });
});
