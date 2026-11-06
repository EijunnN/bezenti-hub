import type {
  AuthClientMetadata,
  AuthClientMetadataDeviceType,
  AuthClientPresentationMetadata,
} from "@t3tools/contracts";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Digest is effectful; the cookie name stays a plain function.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import { normalizeHostname } from "@t3tools/shared/hostClassification";
import * as Mac from "effect/crypto/Mac";
import * as Option from "effect/Option";

import { normalizeClientAddress } from "./clientConnection.ts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

const SESSION_COOKIE_NAME = "t3_session";

/** Cookies span ports; use separate names for servers sharing a hostname. */
export function resolveSessionCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly port: number;
  readonly host: string | undefined;
  readonly instanceKey: string;
  readonly environmentId: string;
  readonly development: boolean;
}): string {
  if (input.mode === "desktop") {
    return `${SESSION_COOKIE_NAME}_${input.port}`;
  }

  const instanceHash = NodeCrypto.createHash("sha256")
    .update(
      !input.development && isRemoteReachableHost(input.host)
        ? input.environmentId
        : input.instanceKey,
    )
    .digest("hex")
    .slice(0, 12);

  if (!input.development && isRemoteReachableHost(input.host)) {
    return `${SESSION_COOKIE_NAME}_${instanceHash}`;
  }

  return `${SESSION_COOKIE_NAME}_${input.port}_${instanceHash}`;
}

export function resolveLegacySessionCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly host: string | undefined;
  readonly development: boolean;
}): string | undefined {
  return input.mode === "web" && !input.development && isRemoteReachableHost(input.host)
    ? SESSION_COOKIE_NAME
    : undefined;
}

/**
 * The loopback address a server given `host` listens on, or undefined when it may listen beyond
 * this machine. Unset means 127.0.0.1. Only a loopback literal or `localhost` counts: Node listens
 * on every interface for an empty host, and any other name resolves through DNS.
 */
export function loopbackBindAddress(host: string | undefined): string | undefined {
  if (host === undefined) return "127.0.0.1";
  const address = normalizeHostname(host);
  if (address === "localhost") return "127.0.0.1";
  return (NodeNet.isIPv4(address) && address.startsWith("127.")) || address === "::1"
    ? address
    : undefined;
}

export const isRemoteReachableHost = (host: string | undefined): boolean =>
  loopbackBindAddress(host) === undefined;

export { base64UrlEncode } from "@t3tools/shared/base64Url";

export function base64UrlDecodeUtf8(input: string): string {
  return Result.getOrThrow(Base64Url.decodeString(input));
}

export function timingSafeEqualBase64Url(left: string, right: string): boolean {
  const leftBytes = Base64Url.decode(left);
  const rightBytes = Base64Url.decode(right);
  return (
    Result.isSuccess(leftBytes) &&
    Result.isSuccess(rightBytes) &&
    Mac.timingSafeEqual(leftBytes.success, rightBytes.success)
  );
}

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function inferDeviceType(userAgent: string | undefined): AuthClientMetadataDeviceType {
  if (!userAgent) {
    return "unknown";
  }

  const normalized = userAgent.toLowerCase();
  if (/bot|crawler|spider|slurp|curl|wget/.test(normalized)) {
    return "bot";
  }
  if (/ipad|tablet/.test(normalized)) {
    return "tablet";
  }
  if (/iphone|android.+mobile|mobile/.test(normalized)) {
    return "mobile";
  }
  return "desktop";
}

function inferBrowser(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  const normalized = userAgent.toLowerCase();
  if (/edg(?:e|a|ios)?\//.test(normalized)) return "Edge";
  if (/opr\/|opios\//.test(normalized)) return "Opera";
  if (/firefox\/|fxios\//.test(normalized)) return "Firefox";
  if (/electron\//.test(normalized)) return "Electron";
  if (/chrome\//.test(normalized) || /crios\//.test(normalized)) return "Chrome";
  if (/safari\//.test(normalized) && !/chrome\//.test(normalized)) return "Safari";
  return undefined;
}

function inferOs(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  const normalized = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(normalized)) return "iOS";
  if (/android/.test(normalized)) return "Android";
  if (/mac os x|macintosh/.test(normalized)) return "macOS";
  if (/windows nt/.test(normalized)) return "Windows";
  if (/linux/.test(normalized)) return "Linux";
  return undefined;
}

/**
 * Client metadata plus how the request reached the server, for rules that need it. Only the
 * `AuthClientMetadata` fields are stored with a session.
 */
export interface AuthRequestMetadata extends AuthClientMetadata {
  /** The client's own connection used HTTPS, directly or through a trusted proxy. */
  readonly secureTransport?: boolean;
}

/**
 * Reads the client from the request the client-connection middleware resolved, so the address is
 * the one a trusted proxy forwarded, not the proxy's.
 */
export function deriveAuthClientMetadata(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly presented?: AuthClientPresentationMetadata;
}): AuthRequestMetadata {
  const userAgent = normalizeNonEmptyString(input.request.headers["user-agent"]);
  const ipAddress = normalizeClientAddress(Option.getOrUndefined(input.request.remoteAddress));
  const os = input.presented?.os ?? inferOs(userAgent);
  const browser = inferBrowser(userAgent);
  return {
    ...(input.presented?.label ? { label: input.presented.label } : {}),
    ...(ipAddress ? { ipAddress } : {}),
    ...(userAgent ? { userAgent } : {}),
    deviceType: input.presented?.deviceType ?? inferDeviceType(userAgent),
    ...(os ? { os } : {}),
    ...(browser ? { browser } : {}),
    secureTransport: input.request.protocol === "https",
  };
}
