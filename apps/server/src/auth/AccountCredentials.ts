import { argon2id, argon2Verify } from "hash-wasm";
import * as Aead from "effect/crypto/Aead";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

// OWASP's argon2id baseline: 19 MiB, two passes, one lane.
const ARGON2_PARAMS = { memorySize: 19_456, iterations: 2, parallelism: 1, hashLength: 32 };

export const hashPassword = Effect.fn("AccountCredentials.hashPassword")(function* (
  password: string,
) {
  const random = yield* SecureRandom.SecureRandom;
  const salt = yield* random.randomBytes(16);
  return yield* Effect.promise(() =>
    argon2id({ ...ARGON2_PARAMS, password, salt, outputType: "encoded" }),
  );
});

export const verifyPassword = Effect.fn("AccountCredentials.verifyPassword")(function* (
  password: string,
  hash: string,
) {
  return yield* Effect.promise(() => argon2Verify({ password, hash }).catch(() => false));
});

const TOTP_PERIOD_SECONDS = 30;
const TOTP_SECRET_BYTES = 20;
// RFC 4648 base32, which authenticator apps expect for the shared secret.
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const toBase32 = (bytes: Uint8Array) => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? output + BASE32_ALPHABET[(value << (5 - bits)) & 31] : output;
};

export const generateTotpSecret = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  return Uint8Array.from(yield* random.randomBytes(TOTP_SECRET_BYTES));
});

export const totpEnrollment = (secret: Uint8Array, accountLabel: string) => {
  const encoded = toBase32(secret);
  const issuer = "T3 Code";
  const params = new URLSearchParams({
    secret: encoded,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(TOTP_PERIOD_SECONDS),
  });
  return {
    secret: encoded,
    otpauthUri: `otpauth://totp/${encodeURIComponent(`${issuer}:${accountLabel}`)}?${params}`,
  };
};

/** RFC 6238 with HMAC-SHA-1, six digits and 30-second steps, as authenticator apps use. */
const totpCodeAt = Effect.fn("AccountCredentials.totpCodeAt")(function* (
  secret: Uint8Array,
  step: number,
) {
  const mac = yield* Mac.Mac;
  const key = yield* Mac.key(Mac.hmacSha1, secret).pipe(Effect.orDie);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const tag = yield* mac.sign(key, counter).pipe(Effect.orDie);
  const offset = (tag[tag.length - 1] ?? 0) & 0x0f;
  const binary = new DataView(tag.buffer, tag.byteOffset + offset, 4).getUint32(0) & 0x7fff_ffff;
  return String(binary % 1_000_000).padStart(6, "0");
});

/**
 * The step `code` matches within one step of `nowMillis` either side (clock drift), or
 * undefined. Callers record the step so a code cannot be replayed.
 */
export const matchTotpStep = Effect.fn("AccountCredentials.matchTotpStep")(function* (
  secret: Uint8Array,
  code: string,
  nowMillis: number,
) {
  const current = Math.floor(nowMillis / 1000 / TOTP_PERIOD_SECONDS);
  const encoder = new TextEncoder();
  for (const step of [current - 1, current, current + 1]) {
    const expected = yield* totpCodeAt(secret, step);
    if (Mac.timingSafeEqual(encoder.encode(expected), encoder.encode(code))) return step;
  }
  return undefined;
});

const SEALED_PREFIX = "v1";

/** AES-256-GCM, bound to `context` (the owning User) so a row cannot be moved to another. */
export const seal = Effect.fn("AccountCredentials.seal")(function* (
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
  context: string,
) {
  const aead = yield* Aead.Aead;
  const key = yield* Aead.key(Aead.aes256Gcm, keyBytes);
  const random = yield* SecureRandom.SecureRandom;
  const nonce = yield* random.randomBytes(12);
  const sealed = yield* aead.encrypt(key, plaintext, {
    nonce,
    aad: new TextEncoder().encode(context),
  });
  return [SEALED_PREFIX, Base64Url.encode(nonce), Base64Url.encode(sealed)].join(".");
});

export const open = Effect.fn("AccountCredentials.open")(function* (
  keyBytes: Uint8Array,
  sealed: string,
  context: string,
) {
  const [prefix, nonceText = "", ciphertextText = ""] = sealed.split(".");
  const nonce = Base64Url.decode(nonceText);
  const ciphertext = Base64Url.decode(ciphertextText);
  if (prefix !== SEALED_PREFIX || Result.isFailure(nonce) || Result.isFailure(ciphertext)) {
    return yield* Effect.die(new Error("Unreadable sealed credential."));
  }
  const aead = yield* Aead.Aead;
  const key = yield* Aead.key(Aead.aes256Gcm, keyBytes);
  return yield* aead.decrypt(key, ciphertext.success, {
    nonce: nonce.success,
    aad: new TextEncoder().encode(context),
  });
});
