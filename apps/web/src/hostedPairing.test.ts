import { describe, expect, it } from "vite-plus/test";

import { hasHostedPairingRequest, readHostedPairingRequest } from "./hostedPairing";

describe("hostedPairing", () => {
  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://hub.example.com/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("reads the token from the hash and the label from the query", () => {
    const url = new URL(
      "https://hub.example.com/pair?host=https%3A%2F%2Fbackend.example.com%3A3773&label=Workstation#token=pairing-token",
    );

    expect(readHostedPairingRequest(url)).toEqual({
      host: "https://backend.example.com:3773",
      token: "pairing-token",
      label: "Workstation",
    });
  });
});
