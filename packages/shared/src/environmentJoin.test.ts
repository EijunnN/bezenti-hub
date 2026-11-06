import { describe, expect, it } from "vite-plus/test";

import {
  assertEnvironmentHubUrl,
  environmentCredentialIssuer,
  environmentJoinPageUrl,
  formatEnvironmentCredential,
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

describe("environment credentials", () => {
  it("name the Hub that issued them", () => {
    const credential = formatEnvironmentCredential("hub:é-1", "secret");
    expect(environmentCredentialIssuer(credential)).toBe("hub:é-1");
    expect(environmentCredentialIssuer("Bearer nonsense")).toBeUndefined();
  });
});

describe("readEnvironmentJoinPageRequest", () => {
  it("reads back the request `t3 join` started", () => {
    const requestId = "request-0123456789abcdef";
    expect(
      readEnvironmentJoinPageRequest(environmentJoinPageUrl("https://hub.example.com", requestId)),
    ).toBe(requestId);
    expect(readEnvironmentJoinPageRequest("https://hub.example.com/register-environment")).toBe(
      null,
    );
  });
});
