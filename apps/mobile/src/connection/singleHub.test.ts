import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  KEPT_CONNECTION_REFUSAL,
  SINGLE_HUB_REFUSAL,
  decideHub,
  registrationRefusal,
} from "./singleHub";

const target = (id: string) => ({
  _tag: "BearerConnectionTarget",
  environmentId: EnvironmentId.make(id),
  connectionId: `bearer:${id}`,
  label: id,
});
const profile = (id: string) => ({
  _tag: "BearerConnectionProfile",
  connectionId: `bearer:${id}`,
  httpBaseUrl: `https://${id}.example.test`,
});
const hub = EnvironmentId.make("hub");

describe("decideHub", () => {
  it("connects the stored Hub without probing anything", async () => {
    const probe = vi.fn(async () => true);
    const decision = await decideHub({
      targets: [target("old"), target("hub")],
      profiles: [profile("old"), profile("hub")],
      stored: { hub },
      probe,
      timeoutMs: 100,
    });
    expect(decision).toEqual({ hub, persist: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it("never connects a kept connection once the stored Hub was removed", async () => {
    const probe = vi.fn(async () => true);
    expect(
      await decideHub({
        targets: [target("old")],
        profiles: [profile("old")],
        stored: { hub: null },
        probe,
        timeoutMs: 100,
      }),
    ).toEqual({ hub: null, persist: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it("migrates several saved connections once: the one answering as a Hub, probed in parallel", async () => {
    const started: Array<string> = [];
    const decision = await decideHub({
      targets: [target("paired"), target("hub"), target("slow")],
      profiles: [profile("paired"), profile("hub"), profile("slow")],
      stored: undefined,
      probe: (url) => {
        started.push(url);
        if (url.includes("slow")) return new Promise(() => undefined);
        return Promise.resolve(url.includes("hub."));
      },
      timeoutMs: 50,
    });
    expect(started).toHaveLength(3);
    expect(decision).toEqual({ hub, persist: true });
  });

  it("keeps everything unconnected when no saved connection answers as a Hub", async () => {
    expect(
      await decideHub({
        targets: [target("a"), target("b")],
        profiles: [profile("a"), profile("b")],
        stored: undefined,
        probe: async () => false,
        timeoutMs: 50,
      }),
    ).toEqual({ hub: null, persist: false });
  });

  it("takes a single saved connection as the Hub", async () => {
    expect(
      await decideHub({
        targets: [target("hub")],
        profiles: [profile("hub")],
        stored: undefined,
        probe: async () => false,
        timeoutMs: 50,
      }),
    ).toEqual({ hub, persist: true });
  });
});

describe("registrationRefusal", () => {
  const kept = [EnvironmentId.make("old")];
  it("lets only the Hub register again, and a new one only while there is no Hub", () => {
    expect(registrationRefusal({ environmentId: hub, hub, kept })).toBeNull();
    expect(registrationRefusal({ environmentId: EnvironmentId.make("x"), hub, kept })).toBe(
      SINGLE_HUB_REFUSAL,
    );
    expect(
      registrationRefusal({ environmentId: EnvironmentId.make("x"), hub: null, kept }),
    ).toBeNull();
  });

  it("refuses a kept connection even with no Hub, unless the User chose it", () => {
    expect(registrationRefusal({ environmentId: kept[0]!, hub, kept })).toBe(SINGLE_HUB_REFUSAL);
    expect(registrationRefusal({ environmentId: kept[0]!, hub: null, kept })).toBe(
      KEPT_CONNECTION_REFUSAL,
    );
  });
});
