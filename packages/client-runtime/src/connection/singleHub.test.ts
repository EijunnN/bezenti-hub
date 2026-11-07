import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chooseSavedHub, makeKeptSavedConnections } from "./singleHub.ts";

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

describe("makeKeptSavedConnections", () => {
  it("counts the saved connections left unconnected and forgets a removed Hub", () => {
    const kept = makeKeptSavedConnections();
    let notified = 0;
    kept.subscribe(() => {
      notified += 1;
    });
    const hubId = EnvironmentId.make("hub");
    kept.record({ saved: 3, connected: hubId });
    expect(kept.count()).toBe(2);
    expect(kept.connected()).toBe(hubId);
    kept.record({ saved: 3, connected: hubId });
    expect(notified).toBe(1);
    kept.forget(EnvironmentId.make("other"));
    expect(kept.connected()).toBe(hubId);
    kept.forget(hubId);
    expect(kept.connected()).toBeNull();
    expect(kept.count()).toBe(2);
    expect(notified).toBe(2);
  });
});
