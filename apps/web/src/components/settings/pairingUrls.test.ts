import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  it("pairs on the endpoint's own address, over HTTP and HTTPS alike", () => {
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
    expect(resolveDesktopPairingUrl("https://hub.example.com", "PAIRCODE")).toBe(
      "https://hub.example.com/pair#token=PAIRCODE",
    );
  });
});
