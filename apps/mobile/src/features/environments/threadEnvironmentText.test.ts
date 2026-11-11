import { describe, expect, it } from "vite-plus/test";

import {
  threadEnvironmentNoticeText,
  threadEnvironmentPresentation,
} from "./threadEnvironmentText";

const laptop = (status: "online" | "reconnecting" | "offline") => ({
  name: "Laptop",
  status,
  isHubMachine: false,
  needsEnvironment: false,
  isSandbox: false,
  startError: null,
});

describe("threadEnvironmentPresentation", () => {
  it("says nothing while the Hub machine is the only Environment and the Thread runs there", () => {
    expect(
      threadEnvironmentPresentation({
        environment: {
          name: "Hub",
          status: "online",
          isHubMachine: true,
          needsEnvironment: false,
          isSandbox: false,
          startError: null,
        },
        hasJoinedEnvironments: false,
        turnUnderWay: false,
      }),
    ).toBeNull();
  });

  it("names the machine and its live status once machines joined", () => {
    expect(
      threadEnvironmentPresentation({
        environment: laptop("online"),
        hasJoinedEnvironments: true,
        turnUnderWay: false,
      }),
    ).toMatchObject({ text: "Laptop", accessibilityText: "runs on Laptop", state: null });
    expect(
      threadEnvironmentPresentation({
        environment: laptop("reconnecting"),
        hasJoinedEnvironments: true,
        turnUnderWay: false,
      }),
    ).toMatchObject({
      text: "Laptop · Reconnecting",
      accessibilityText: "runs on Laptop, reconnecting",
      status: "reconnecting",
    });
  });

  it("pauses a turn whose machine is offline, and needs an environment once it was removed", () => {
    expect(
      threadEnvironmentPresentation({
        environment: laptop("offline"),
        hasJoinedEnvironments: true,
        turnUnderWay: true,
      }),
    ).toMatchObject({
      text: "Paused, environment offline · Laptop",
      state: "paused-offline",
    });
    expect(
      threadEnvironmentPresentation({
        environment: {
          name: "No environment",
          status: "offline",
          isHubMachine: false,
          needsEnvironment: true,
          isSandbox: false,
          startError: null,
        },
        hasJoinedEnvironments: false,
        turnUnderWay: false,
      }),
    ).toMatchObject({
      text: "Needs an environment",
      accessibilityText: "needs an environment",
      state: "needs-environment",
    });
  });

  it("says a Sandbox is starting, or that it could not start", () => {
    const sandbox = (status: "starting" | "failed") => ({
      name: "Acme Sandbox",
      status,
      isHubMachine: false,
      needsEnvironment: false,
      isSandbox: true,
      startError: status === "failed" ? "its server exited (exit code 137)." : null,
    });
    expect(
      threadEnvironmentPresentation({
        environment: sandbox("starting"),
        hasJoinedEnvironments: true,
        turnUnderWay: false,
      }),
    ).toMatchObject({
      text: "Starting the Sandbox… · Acme Sandbox",
      accessibilityText: "starting the sandbox…, runs on Acme Sandbox",
      state: "sandbox-starting",
    });
    expect(
      threadEnvironmentPresentation({
        environment: sandbox("failed"),
        hasJoinedEnvironments: true,
        turnUnderWay: true,
      }),
    ).toMatchObject({
      text: "The Sandbox could not start · Acme Sandbox",
      state: "sandbox-failed",
    });
  });

  it("says nothing for a machine the User can't see", () => {
    expect(
      threadEnvironmentPresentation({
        environment: null,
        hasJoinedEnvironments: true,
        turnUnderWay: true,
      }),
    ).toBeNull();
  });
});

describe("a Thread on a Sandbox or a dedicated machine", () => {
  const sandbox = (
    status: "online" | "stopped" | "starting" | "failed",
    startError: string | null = null,
  ) =>
    threadEnvironmentPresentation({
      environment: {
        name: "Acme Sandbox",
        status,
        isHubMachine: false,
        needsEnvironment: false,
        isSandbox: true,
        startError,
      },
      hasJoinedEnvironments: true,
      turnUnderWay: false,
    });

  it("names the Sandbox with its state, the same words as web", () => {
    expect(sandbox("online")).toMatchObject({ text: "Acme Sandbox", state: null });
    expect(sandbox("stopped")).toMatchObject({ text: "Acme Sandbox · Stopped", state: null });
    expect(sandbox("starting")).toMatchObject({
      text: "Starting the Sandbox… · Acme Sandbox",
      state: "sandbox-starting",
      status: "starting",
    });
    expect(sandbox("failed", "Podman is not installed")).toMatchObject({
      text: "The Sandbox could not start · Acme Sandbox",
      accessibilityText: "the sandbox could not start, runs on Acme Sandbox",
      state: "sandbox-failed",
    });
  });

  it("explains in the Thread why it waits: starting, failed with why, or needing an environment", () => {
    expect(threadEnvironmentNoticeText(sandbox("online"))).toBeNull();
    expect(threadEnvironmentNoticeText(sandbox("stopped"))).toBeNull();
    expect(threadEnvironmentNoticeText(sandbox("starting"))).toBe(
      "Starting the Sandbox… Acme Sandbox starts for this Thread's work; the Thread goes on once it runs.",
    );
    expect(threadEnvironmentNoticeText(sandbox("failed", "Podman is not installed"))).toBe(
      "The Sandbox could not start: Podman is not installed",
    );
    const removed = threadEnvironmentPresentation({
      environment: {
        name: "No environment",
        status: "offline",
        isHubMachine: false,
        needsEnvironment: true,
        isSandbox: false,
        startError: null,
      },
      hasJoinedEnvironments: false,
      turnUnderWay: false,
    });
    expect(removed).toMatchObject({ text: "Needs an environment", state: "needs-environment" });
    expect(threadEnvironmentNoticeText(removed)).toMatch(/^Needs an environment: /u);
  });

  it("names a dedicated machine like any machine, with its status", () => {
    expect(
      threadEnvironmentPresentation({
        environment: {
          name: "Acme VPS",
          status: "offline",
          isHubMachine: false,
          needsEnvironment: false,
          isSandbox: false,
          startError: null,
        },
        hasJoinedEnvironments: true,
        turnUnderWay: true,
      }),
    ).toMatchObject({ text: "Paused, environment offline · Acme VPS", state: "paused-offline" });
  });
});
