import * as Base64Url from "effect/encoding/Base64Url";

/** Unpadded base64url (RFC 4648 §5) of bytes, or of a string's UTF-8 bytes. */
export function base64UrlEncode(input: string | Uint8Array): string {
  return Base64Url.encode(typeof input === "string" ? new TextEncoder().encode(input) : input);
}
