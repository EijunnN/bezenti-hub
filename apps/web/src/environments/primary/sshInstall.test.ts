import { HubEnvironmentName } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { defaultMachineName } from "./sshInstall";

const isMachineName = Schema.is(HubEnvironmentName);

describe("defaultMachineName", () => {
  it("names a machine by its address or its host name's first label, as a valid name", () => {
    expect(defaultMachineName("vps-1.example.com")).toBe("vps-1");
    expect(defaultMachineName(" 10.0.0.5 ")).toBe("10.0.0.5");
    expect(defaultMachineName("[2001:db8::1]")).toBe("2001:db8::1");
    const long = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.example.com`;
    expect(long.length).toBeGreaterThan(64);
    for (const host of [long, "vps-1.example.com", "10.0.0.5", "2001:db8::1"]) {
      expect(isMachineName(defaultMachineName(host)), host).toBe(true);
    }
  });
});
