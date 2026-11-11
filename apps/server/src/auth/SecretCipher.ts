// @effect-diagnostics nodeBuiltinImport:off - AES-256-GCM, HKDF and the CSPRNG come from node:crypto.
/**
 * The master key and the sealed format of every encrypted value (AES-256-GCM, an HKDF subkey per
 * purpose, a random nonce per seal, header + purpose + name as associated data). Pure; the format
 * and its reasons are in docs/internals/secrets.md.
 */
import * as NodeCrypto from "node:crypto";

const MASTER_KEY_BYTES = 32;
const KEY_ID_BYTES = 8;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Starts with NUL: no text value starts so, which tells a sealed value from a stored plain one. */
const MAGIC = Buffer.from([0x00, 0x54, 0x33, 0x53]);
const FORMAT_V1 = 0x01;
const HEADER_BYTES = MAGIC.length + 1 + KEY_ID_BYTES;
const KEY_TEXT_PREFIX = "t3-master-key-v1:";

/** What a sealed value is for: each gets its own subkey. */
export type SealPurpose = "server-secret" | "key-check";

const hkdf = (key: Buffer, info: string, length: number) =>
  Buffer.from(NodeCrypto.hkdfSync("sha256", key, Buffer.alloc(0), info, length));

/**
 * A master key. Its bytes stay in a private field: logging, inspecting or serialising one shows
 * only its id.
 */
export class MasterKey {
  readonly #bytes: Buffer;
  readonly #subkeys = new Map<SealPurpose, Buffer>();
  /** The key's fingerprint in hex: safe to show, store and log. */
  readonly id: string;
  readonly idBytes: Buffer;

  private constructor(bytes: Buffer) {
    this.#bytes = bytes;
    this.idBytes = hkdf(bytes, "t3code master key id v1", KEY_ID_BYTES);
    this.id = this.idBytes.toString("hex");
  }

  static generate(): MasterKey {
    return new MasterKey(NodeCrypto.randomBytes(MASTER_KEY_BYTES));
  }

  /** The key file's and the backup's text, or undefined when `text` is not one. */
  static parse(text: string): MasterKey | undefined {
    const trimmed = text.trim();
    if (!trimmed.startsWith(KEY_TEXT_PREFIX)) return undefined;
    const encoded = trimmed.slice(KEY_TEXT_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return undefined;
    const bytes = Buffer.from(encoded, "base64url");
    return bytes.length === MASTER_KEY_BYTES ? new MasterKey(bytes) : undefined;
  }

  /** The text written to the key file and handed out as a backup: the key itself. */
  exportText(): string {
    return `${KEY_TEXT_PREFIX}${this.#bytes.toString("base64url")}\n`;
  }

  subkey(purpose: SealPurpose): Buffer {
    let subkey = this.#subkeys.get(purpose);
    if (subkey === undefined) {
      subkey = hkdf(this.#bytes, `t3code ${purpose} v1`, MASTER_KEY_BYTES);
      this.#subkeys.set(purpose, subkey);
    }
    return subkey;
  }

  toString(): string {
    return `MasterKey(${this.id})`;
  }

  toJSON(): { readonly id: string } {
    return { id: this.id };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

const associatedData = (header: Buffer, purpose: SealPurpose, name: string) =>
  Buffer.concat([header, Buffer.from(`${purpose}\u0000${name}`, "utf8")]);

export const seal = (
  key: MasterKey,
  purpose: SealPurpose,
  name: string,
  plaintext: Uint8Array,
): Uint8Array => {
  const header = Buffer.concat([MAGIC, Buffer.from([FORMAT_V1]), key.idBytes]);
  const nonce = NodeCrypto.randomBytes(NONCE_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key.subkey(purpose), nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(associatedData(header, purpose, name));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([header, nonce, ciphertext, cipher.getAuthTag()]));
};

/** What a stored value is: in clear (from before encryption), sealed by a key, or unreadable. */
export type StoredForm =
  | { readonly _tag: "plain" }
  | { readonly _tag: "sealed"; readonly keyId: string }
  /** Starts like a sealed value but of a format this version does not know: never plain. */
  | { readonly _tag: "unknown-format" };

export const classify = (stored: Uint8Array): StoredForm => {
  const bytes = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
  if (bytes.length < MAGIC.length || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    return { _tag: "plain" };
  }
  if (bytes[MAGIC.length] !== FORMAT_V1 || bytes.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES) {
    return { _tag: "unknown-format" };
  }
  return {
    _tag: "sealed",
    keyId: bytes.subarray(MAGIC.length + 1, HEADER_BYTES).toString("hex"),
  };
};

export type OpenResult =
  | { readonly _tag: "opened"; readonly plaintext: Uint8Array }
  /** Not sealed: a value in clear, or a format this version does not know. */
  | { readonly _tag: "not-sealed" }
  /** Sealed by a key not among those given. */
  | { readonly _tag: "unknown-key"; readonly keyId: string }
  /** The key matches but the value does not open: altered, or stored under another name. */
  | { readonly _tag: "rejected" };

export const open = (
  keys: ReadonlyArray<MasterKey>,
  purpose: SealPurpose,
  name: string,
  stored: Uint8Array,
): OpenResult => {
  const form = classify(stored);
  if (form._tag !== "sealed") return { _tag: "not-sealed" };
  const key = keys.find((candidate) => candidate.id === form.keyId);
  if (key === undefined) return { _tag: "unknown-key", keyId: form.keyId };
  const bytes = Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength);
  const header = bytes.subarray(0, HEADER_BYTES);
  const nonce = bytes.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const ciphertext = bytes.subarray(HEADER_BYTES + NONCE_BYTES, bytes.length - TAG_BYTES);
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key.subkey(purpose), nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(associatedData(header, purpose, name));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { _tag: "opened", plaintext: new Uint8Array(plaintext) };
  } catch {
    return { _tag: "rejected" };
  }
};
