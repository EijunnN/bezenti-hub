import { describe, expect, it } from "vite-plus/test";

import { threadEnvironmentPresentation } from "./threadEnvironmentText";

const laptop = (status: "online" | "reconnecting" | "offline") => ({
  name: "Laptop",
  status,
  isHubMachine: false,
  needsEnvironment: false,
});

describe("threadEnvironmentPresentation", () => {
  it("says nothing while the Hub machine is the only Environment and the Thread runs there", () => {
    expect(
      threadEnvironmentPresentation({
        environment: { name: "Hub", status: "online", isHubMachine: true, needsEnvironment: false },
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
