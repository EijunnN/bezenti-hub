import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/http";

import { parseTrustedProxies, withClientConnection } from "./auth/clientConnection.ts";
import { requestUrl } from "./requestUrl.ts";

const forwarded = (peerAddress: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1:3773/mcp", {
      headers: {
        host: "127.0.0.1:3773",
        "x-forwarded-host": "hub.example.com",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "198.51.100.1",
      },
    }),
  ).modify({ remoteAddress: Option.some(peerAddress), peerAddress: Option.some(peerAddress) });

const originThrough = (peerAddress: string) =>
  Option.getOrUndefined(
    requestUrl(
      withClientConnection(
        forwarded(peerAddress),
        Result.getOrThrow(parseTrustedProxies("loopback")),
      ),
    ),
  )?.origin;

describe("requestUrl", () => {
  it("is the origin a trusted proxy reports, so links made from it reach the Hub", () => {
    expect(originThrough("127.0.0.1")).toBe("https://hub.example.com");
  });

  it("ignores forwarding headers from a peer that is not a trusted proxy", () => {
    expect(originThrough("203.0.113.5")).toBe("http://127.0.0.1:3773");
  });
});
