import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as IpNetwork from "effect/net/IpNetwork";
import * as NetAddress from "effect/net/NetAddress";

/**
 * Which direct peers may tell the server who the client is. `loopback` covers the proxies that
 * reach the server on this machine: Tailscale Serve, the T3 Connect tunnel, a local Caddy or nginx.
 */
export interface TrustedProxies {
  readonly loopback: boolean;
  readonly networks: ReadonlyArray<IpNetwork.IpNetwork>;
}

export const DEFAULT_TRUSTED_PROXIES: TrustedProxies = { loopback: true, networks: [] };

/**
 * Parses `T3CODE_TRUSTED_PROXIES`: comma- or space-separated CIDRs, single addresses,
 * `loopback`, or `none`. The list replaces the default, so keep `loopback` when a local
 * proxy or tunnel also reaches the server.
 */
export const parseTrustedProxies = (value: string): Result.Result<TrustedProxies, string> => {
  let loopback = false;
  const networks: Array<IpNetwork.IpNetwork> = [];
  for (const entry of value.split(/[\s,]+/).filter((part) => part.length > 0)) {
    const lower = entry.toLowerCase();
    if (lower === "loopback") {
      loopback = true;
      continue;
    }
    if (lower === "none") continue;
    const network = entry.includes("/")
      ? IpNetwork.fromString(entry)
      : Result.flatMap(NetAddress.ipFromString(entry), (address) =>
          IpNetwork.fromAddress(address, NetAddress.width(address)),
        );
    if (Result.isFailure(network)) {
      return Result.fail(`"${entry}" is not an IP address, a CIDR range, loopback or none.`);
    }
    networks.push(network.success);
  }
  return Result.succeed({ loopback, networks });
};

/** An address from a socket or a forwarding header: brackets, port and IPv4 mapping removed. */
const parseAddress = (input: string | undefined): NetAddress.IpAddress | undefined => {
  if (input === undefined) return undefined;
  let value = input.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1] ?? "";
  else if (/^[\d.]+:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));
  const ip = NetAddress.ipFromString(value);
  return Result.isSuccess(ip) ? NetAddress.toCanonical(ip.success) : undefined;
};

const isTrusted = (proxies: TrustedProxies, address: NetAddress.IpAddress) =>
  (proxies.loopback && NetAddress.isLoopback(address)) ||
  proxies.networks.some((network) => IpNetwork.contains(network, address));

const splitList = (value: string | undefined) =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

/** RFC 7239 `Forwarded`: one element per hop, each with optional `for` and `proto`. */
const parseForwarded = (value: string | undefined) =>
  splitList(value).map((element) => {
    const pairs = new Map<string, string>();
    for (const pair of element.split(";")) {
      const separator = pair.indexOf("=");
      if (separator === -1) continue;
      pairs.set(pair.slice(0, separator).trim().toLowerCase(), pair.slice(separator + 1).trim());
    }
    const proto = pairs.get("proto")?.replace(/^"|"$/g, "");
    return { for: pairs.get("for"), proto };
  });

export interface ClientConnection {
  /** The client's address, or the direct peer when no trusted proxy forwarded one. */
  readonly address: string | undefined;
  /** Whether the client's own connection used HTTPS. */
  readonly secure: boolean;
}

/**
 * Who is on the other end of a request. Forwarding headers count only when the direct peer is a
 * trusted proxy, and then the hops are walked from the right: the first one that is not itself a
 * trusted proxy is the client, so an address a client writes into the header is never chosen.
 * The scheme is the one the nearest proxy reports.
 */
export const resolveClientConnection = (input: {
  readonly peerAddress: string | undefined;
  readonly protocol: "http" | "https" | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly trustedProxies: TrustedProxies;
}): ClientConnection => {
  const peer = parseAddress(input.peerAddress);
  const transportSecure = input.protocol === "https";
  if (peer === undefined || !isTrusted(input.trustedProxies, peer)) {
    return {
      address: peer === undefined ? input.peerAddress : NetAddress.formatIp(peer),
      secure: transportSecure,
    };
  }
  const xForwardedFor = splitList(input.headers["x-forwarded-for"]);
  const forwarded = xForwardedFor.length === 0 ? parseForwarded(input.headers.forwarded) : [];
  const hops = xForwardedFor.length > 0 ? xForwardedFor : forwarded.map((hop) => hop.for ?? "");

  let client = peer;
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = parseAddress(hops[index]);
    if (hop === undefined) break;
    client = hop;
    if (!isTrusted(input.trustedProxies, hop)) break;
  }

  const proto =
    splitList(input.headers["x-forwarded-proto"]).at(-1) ??
    parseForwarded(input.headers.forwarded)
      .map((hop) => hop.proto)
      .findLast((value) => value !== undefined);
  return {
    address: NetAddress.formatIp(client),
    secure: proto === undefined ? transportSecure : proto.toLowerCase() === "https",
  };
};

/**
 * The request as the client made it: `remoteAddress` is the client, `protocol` its scheme, and
 * `peerAddress` the direct peer. Every per-client rule (sign-in back-off, session metadata, the
 * plain-HTTP refusal, Secure cookies) reads these, never the forwarding headers.
 */
export const withClientConnection = (
  request: HttpServerRequest.HttpServerRequest,
  trustedProxies: TrustedProxies,
): HttpServerRequest.HttpServerRequest => {
  const connection = resolveClientConnection({
    peerAddress: Option.getOrUndefined(request.peerAddress),
    protocol: request.protocol,
    headers: request.headers,
    trustedProxies,
  });
  return request.modify({
    remoteAddress: Option.fromUndefinedOr(connection.address),
    peerAddress: request.peerAddress,
    protocol: connection.secure ? "https" : "http",
  });
};
