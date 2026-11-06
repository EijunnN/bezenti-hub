import { describe, expect, it } from "vite-plus/test";

import {
  assertEnvironmentHubUrl,
  environmentJoinPageUrl,
  readEnvironmentJoinPageRequest,
} from "./environmentJoin.ts";

describe("assertEnvironmentHubUrl", () => {
  it.each([
    "https://hub.example.com",
    "https://hub.example.com:8443/",
    "http://localhost:3773",
    "http://127.0.0.1:3773",
    "http://[::1]:3773",
  ])("accepts %s", (url) => {
    expect(() => assertEnvironmentHubUrl(url)).not.toThrow();
  });

  // The credential would cross the network in clear text, LAN and tailnet included.
  it.each([
    "http://hub.example.com",
    "http://192.168.1.20:3773",
    "http://my-box.tail1234.ts.net",
    "ws://hub.example.com",
    "ftp://hub.example.com",
    "https://ada:secret@hub.example.com",
    "hub.example.com",
  ])("refuses %s", (url) => {
    expect(() => assertEnvironmentHubUrl(url)).toThrow();
  });
});

describe("readEnvironmentJoinPageRequest", () => {
  const request = {
    redirectUri: "http://127.0.0.1:51234/callback",
    codeChallenge: "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c",
    state: "state-0123456789abcdef",
    name: "laptop",
    os: "linux",
    hostname: "laptop",
    requestedAt: "2026-11-06T10:00:00.000Z",
  };

  it("reads back what `t3 join` put in the page URL", () => {
    expect(
      readEnvironmentJoinPageRequest(environmentJoinPageUrl("https://hub.example.com", request)),
    ).toEqual(request);
  });

  it("refuses to send the code anywhere but a loopback port", () => {
    for (const redirectUri of ["t3code://auth/callback", "https://evil.example.com/callback"]) {
      expect(
        readEnvironmentJoinPageRequest(
          environmentJoinPageUrl("https://hub.example.com", { ...request, redirectUri }),
        ),
      ).toBeNull();
    }
  });
});
