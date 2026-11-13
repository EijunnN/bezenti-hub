/**
 * Spec 5 ticket 05: the one rule that turns a secret's value into `[NAME]`: as written, JSON- and
 * URL-encoded, and in base64 at any byte alignment. Values shorter than 6 are never masked (open
 * question 3). Logs and spans use the values this process knows ({@link rememberKnownSecrets}).
 */

/** Shorter values are delivered but never masked (the Vault marks them `unmasked`). */
export const MIN_MASKED_SECRET_LENGTH = 6;

/** A base64 run shorter than this is too likely to occur by chance. */
const MIN_BASE64_LENGTH = 8;

export interface MaskableSecret {
  readonly name: string;
  readonly value: string;
}

export interface SecretPatterns {
  /** No value to look for: every call returns its input. */
  readonly isEmpty: boolean;
  /** Every known form of every value replaced by `[NAME]`. */
  readonly mask: (text: string) => string;
  /**
   * The length of the longest end of `text` that is the start of a value's form, but not a whole
   * one: what the next chunk of a stream could complete. 0 when nothing could.
   */
  readonly pendingSuffix: (text: string) => number;
  /** Whether `text` holds any value's form. */
  readonly matches: (text: string) => boolean;
}

const BASE64 = /[A-Za-z0-9+/]/;

/** The characters of `bytes`' base64 that depend on `bytes` alone, when `offset` bytes precede. */
const base64Core = (bytes: Uint8Array, offset: 0 | 1 | 2): string => {
  const padded = new Uint8Array(offset + bytes.length);
  padded.set(bytes, offset);
  const encoded = Buffer.from(padded).toString("base64");
  const first = Math.ceil((8 * offset) / 6);
  const end = Math.floor((8 * (offset + bytes.length)) / 6);
  return encoded.slice(first, end);
};

/** The forms of one value the masker looks for: as written, URL-encoded, base64. */
export const secretForms = (value: string): ReadonlyArray<string> => {
  if (value.length < MIN_MASKED_SECRET_LENGTH) return [];
  // As written, and as a JSON string holds it (log and trace lines are JSON).
  const forms = new Set<string>([value, JSON.stringify(value).slice(1, -1)]);
  try {
    forms.add(encodeURIComponent(value));
  } catch {
    // A lone surrogate has no URL encoding; the value as written is still masked.
  }
  const bytes = new TextEncoder().encode(value);
  for (const offset of [0, 1, 2] as const) {
    const core = base64Core(bytes, offset);
    if (core.length >= MIN_BASE64_LENGTH && [...core].every((c) => BASE64.test(c))) {
      forms.add(core);
    }
  }
  return [...forms];
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const EMPTY: SecretPatterns = {
  isEmpty: true,
  mask: (text) => text,
  pendingSuffix: () => 0,
  matches: () => false,
};

/**
 * The patterns of a set of secrets. A form two secrets share masks as the first one's name, so
 * pass them in precedence order. Longer forms win over shorter ones they contain.
 */
export const makeSecretPatterns = (secrets: Iterable<MaskableSecret>): SecretPatterns => {
  const nameOf = new Map<string, string>();
  for (const secret of secrets) {
    for (const form of secretForms(secret.value)) {
      if (!nameOf.has(form)) nameOf.set(form, secret.name);
    }
  }
  if (nameOf.size === 0) return EMPTY;
  const forms = [...nameOf.keys()].sort((a, b) => b.length - a.length);
  const alternatives = forms.map(escapeRegExp).join("|");
  const test = new RegExp(alternatives);
  // Every start of a form (the longest there), so overlapping values merge into one mask.
  const starts = new RegExp(`(?=(${alternatives}))`, "g");
  const mask = (text: string): string => {
    if (text.length === 0 || !test.test(text)) return text;
    let out = "";
    let cursor = 0;
    let current: { start: number; end: number; name: string } | undefined;
    for (const match of text.matchAll(starts)) {
      const start = match.index;
      const form = match[1] ?? "";
      const end = start + form.length;
      if (current !== undefined && start < current.end) {
        current.end = Math.max(current.end, end);
        continue;
      }
      if (current !== undefined) {
        out += `${text.slice(cursor, current.start)}[${current.name}]`;
        cursor = current.end;
      }
      current = { start, end, name: nameOf.get(form) ?? "" };
    }
    if (current !== undefined) {
      out += `${text.slice(cursor, current.start)}[${current.name}]`;
      cursor = current.end;
    }
    return out + text.slice(cursor);
  };
  // By last character, so a chunk's end is checked against the forms that could continue it.
  const byChar = new Map<string, Array<string>>();
  for (const form of forms) {
    for (let k = 1; k < form.length; k += 1) {
      const char = form[k - 1]!;
      const list = byChar.get(char) ?? [];
      if (list.at(-1) !== form) list.push(form);
      byChar.set(char, list);
    }
  }
  return {
    isEmpty: false,
    mask,
    matches: (text) => test.test(text),
    pendingSuffix: (text) => {
      const last = text.at(-1);
      if (last === undefined) return 0;
      let longest = 0;
      for (const form of byChar.get(last) ?? []) {
        for (let k = Math.min(form.length - 1, text.length); k > longest; k -= 1) {
          if (form[k - 1] === last && text.endsWith(form.slice(0, k))) {
            longest = k;
            break;
          }
        }
      }
      return longest;
    },
  };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Every string inside plain objects and arrays masked; anything else (class instances such as
 * dates, numbers, keys) kept. Returns the same reference when nothing changed.
 */
export const maskDeep = <A>(value: A, mask: (text: string) => string): A => {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return mask(node);
    if (Array.isArray(node)) {
      let changed: Array<unknown> | undefined;
      for (let index = 0; index < node.length; index += 1) {
        const next = walk(node[index]);
        if (next !== node[index]) {
          changed ??= [...node];
          changed[index] = next;
        }
      }
      return changed ?? node;
    }
    if (isPlainObject(node)) {
      let changed: Record<string, unknown> | undefined;
      for (const [key, entry] of Object.entries(node)) {
        const next = walk(entry);
        if (next !== entry) {
          changed ??= { ...node };
          changed[key] = next;
        }
      }
      return changed ?? node;
    }
    return node;
  };
  return walk(value) as A;
};

// ── The values this process knows, for its logs and spans ──────────────────────────────────

/** Bounds memory if a process sees very many values over its life. */
const MAX_KNOWN_SECRETS = 4096;
const known = new Map<string, string>();
let knownPatterns: SecretPatterns = EMPTY;

/**
 * Values this process holds (delivered to it, or read by the Hub to mask a Thread): from now on
 * its logs, spans and trace files show them as `[NAME]`. Short values are ignored.
 */
export const rememberKnownSecrets = (secrets: Iterable<MaskableSecret>): void => {
  let added = false;
  for (const secret of secrets) {
    if (secret.value.length < MIN_MASKED_SECRET_LENGTH || known.has(secret.value)) continue;
    if (known.size >= MAX_KNOWN_SECRETS) {
      const oldest = known.keys().next().value;
      if (oldest !== undefined) known.delete(oldest);
    }
    known.set(secret.value, secret.name);
    added = true;
  }
  if (added) {
    knownPatterns = makeSecretPatterns(
      [...known].map(([value, name]) => ({ name, value })).reverse(),
    );
  }
};

/** The process-wide patterns: what {@link redactKnownSecrets} uses. */
export const knownSecretPatterns = (): SecretPatterns => knownPatterns;

/** `text` with every value this process knows shown as `[NAME]`. */
export const redactKnownSecrets = (text: string): string => knownPatterns.mask(text);

/** {@link maskDeep} with the values this process knows. */
export const redactKnownSecretsDeep = <A>(value: A): A =>
  knownPatterns.isEmpty ? value : maskDeep(value, knownPatterns.mask);

/** Tests only: forget every known value. */
export const forgetKnownSecretsForTest = (): void => {
  known.clear();
  knownPatterns = EMPTY;
};
