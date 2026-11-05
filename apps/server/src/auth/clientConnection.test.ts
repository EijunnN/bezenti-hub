import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  DEFAULT_TRUSTED_PROXIES,
  isPrivateClientAddress,
  parseTrustedProxies,
  resolveClientConnection,
  type TrustedProxies,
} from "./clientConnection.ts";

const proxies = (value: string): TrustedProxies => Result.getOrThrow(parseTrustedProxies(value));

const resolve = (
  peerAddress: string | undefined,
  headers: Record<string, string>,
  trustedProxies: TrustedProxies = DEFAULT_TRUSTED_PROXIES,
) => resolveClientConnection({ peerAddress, protocol: undefined, headers, trustedProxies });

describe("resolveClientConnection", () => {
  it("ignores forwarding headers from a peer that is not a trusted proxy", () => {
    expect(
      resolve("203.0.113.5", {
        "x-forwarded-for": "198.51.100.1",
        "x-forwarded-proto": "https",
        forwarded: "for=198.51.100.2;proto=https",
      }),
    ).toMatchObject({ address: "203.0.113.5", secure: false });
  });

  it("reads the client and scheme a loopback proxy forwards by default", () => {
    expect(
      resolve("::ffff:127.0.0.1", {
        "x-forwarded-for": "198.51.100.1",
        "x-forwarded-proto": "https",
      }),
    ).toMatchObject({ address: "198.51.100.1", secure: true });
  });

  it("takes the right-most untrusted hop, so a client cannot prepend its own address", () => {
    const trusted = proxies("10.0.0.0/8");
    expect(
      resolve("10.0.0.2", { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.0.0.9" }, trusted),
    ).toMatchObject({ address: "198.51.100.7", secure: false });
  });

  it("takes the left-most hop when every hop is a trusted proxy", () => {
    expect(
      resolve("10.0.0.2", { "x-forwarded-for": "10.0.0.3" }, proxies("10.0.0.0/8")),
    ).toMatchObject({
      address: "10.0.0.3",
      secure: false,
    });
  });

  it("leaves the client unknown when a trusted proxy cannot name it", () => {
    const trusted = proxies("10.0.0.0/8");
    expect(resolve("10.0.0.2", { "x-forwarded-for": "unknown, 10.0.0.3" }, trusted).address).toBe(
      undefined,
    );
    expect(resolve("127.0.0.1", { forwarded: "for=unknown;proto=https" }).address).toBe(undefined);
    expect(resolve("127.0.0.1", { forwarded: "for=_hidden" }).address).toBe(undefined);
    expect(resolve("127.0.0.1", { forwarded: "proto=https" }).address).toBe(undefined);
    // A tunnel that reports the scheme but not the client is not a browser on this machine.
    expect(resolve("127.0.0.1", { "x-forwarded-proto": "https" })).toMatchObject({
      address: undefined,
      secure: true,
    });
    // Nothing forwarded: the loopback peer is the client.
    expect(resolve("127.0.0.1", {}).address).toBe("127.0.0.1");
  });

  it("takes the host only from a trusted proxy", () => {
    expect(resolve("127.0.0.1", { "x-forwarded-host": "hub.example.com" }).forwardedHost).toBe(
      "hub.example.com",
    );
    expect(resolve("203.0.113.5", { "x-forwarded-host": "hub.example.com" }).forwardedHost).toBe(
      undefined,
    );
  });

  it("uses the scheme the nearest proxy reports", () => {
    expect(
      resolve("127.0.0.1", {
        "x-forwarded-for": "198.51.100.1",
        "x-forwarded-proto": "https, http",
      }),
    ).toMatchObject({ address: "198.51.100.1", secure: false });
  });

  it("parses IPv6 and IPv4-mapped hops and the Forwarded header", () => {
    expect(
      resolve("::1", { forwarded: 'for="[2001:db8::1]:4711";proto=https, for=127.0.0.1' }),
    ).toMatchObject({ address: "2001:db8::1", secure: true });
    expect(resolve("::1", { "x-forwarded-for": "::ffff:198.51.100.9" })).toMatchObject({
      address: "198.51.100.9",
      secure: false,
    });
    expect(resolve("::ffff:203.0.113.5", {})).toMatchObject({
      address: "203.0.113.5",
      secure: false,
    });
  });

  it("trusts nothing when the setting is none, not even loopback", () => {
    expect(
      resolve("127.0.0.1", { "x-forwarded-for": "198.51.100.1" }, proxies("none")),
    ).toMatchObject({
      address: "127.0.0.1",
      secure: false,
    });
  });
});

describe("isPrivateClientAddress", () => {
  it("counts loopback, LAN and tailnet clients as private, and unknown or public ones not", () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "192.168.1.31",
      "10.1.2.3",
      "100.90.1.2",
      "fd7a:115c:a1e0::5",
    ]) {
      expect(isPrivateClientAddress(address)).toBe(true);
    }
    for (const address of [undefined, "203.0.113.5", "169.254.1.1", "2001:db8::1", "unknown"]) {
      expect(isPrivateClientAddress(address)).toBe(false);
    }
  });
});

describe("parseTrustedProxies", () => {
  it("accepts loopback, CIDRs and single addresses", () => {
    const parsed = proxies("loopback, 10.0.0.0/8 192.0.2.7 fd00::/8");
    expect(parsed.loopback).toBe(true);
    expect(parsed.networks).toHaveLength(3);
    expect(resolve("192.0.2.7", { "x-forwarded-for": "198.51.100.1" }, parsed).address).toBe(
      "198.51.100.1",
    );
  });

  it("refuses an entry that is not a network", () => {
    expect(Result.isFailure(parseTrustedProxies("10.0.0.0/8, proxy.internal"))).toBe(true);
  });
});
