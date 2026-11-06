import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chooseSavedHub } from "./singleHub";

const target = (tag: string, id: string) => ({
  _tag: tag,
  environmentId: EnvironmentId.make(id),
  connectionId: `connection-${id}`,
});
const profile = (id: string) => ({
  _tag: "BearerConnectionProfile",
  connectionId: `connection-${id}`,
  httpBaseUrl: `https://${id}.example.test`,
});

describe("chooseSavedHub", () => {
  const ssh = target("SshConnectionTarget", "devbox");
  const paired = target("BearerConnectionTarget", "old-server");
  const hub = target("BearerConnectionTarget", "hub");
  const profiles = [profile("old-server"), profile("hub")];

  it("connects the saved Hub that answers for itself, not the first saved", async () => {
    const chosen = await chooseSavedHub({
      targets: [ssh, paired, hub],
      profiles,
      slots: 1,
      probe: async (url, environmentId) =>
        url === "https://hub.example.test" && environmentId === hub.environmentId,
    });
    expect(chosen).toEqual([hub]);
  });

  it("falls back to a bearer connection when no Hub answers, and to none without a slot", async () => {
    const offline = async () => false;
    expect(
      await chooseSavedHub({ targets: [ssh, paired, hub], profiles, slots: 1, probe: offline }),
    ).toEqual([paired]);
    expect(
      await chooseSavedHub({ targets: [ssh, paired, hub], profiles, slots: 0, probe: offline }),
    ).toEqual([]);
  });
});
