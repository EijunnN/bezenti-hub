import { assert, describe, it } from "@effect/vitest";

import {
  forgetKnownSecretsForTest,
  makeSecretPatterns,
  maskDeep,
  maskWhole,
  MIN_MASKED_SECRET_LENGTH,
  redactKnownSecrets,
  rememberKnownSecrets,
  secretForms,
  SecretStreamGuard,
} from "./secretMasking.ts";

const TOKEN = "sk-live-7f3a9c2e1b";

describe("secretMasking", () => {
  it("masks a value as written, URL-encoded and in base64", () => {
    const patterns = makeSecretPatterns([
      { name: "API_TOKEN", value: TOKEN },
      { name: "DB_URL", value: "p@ss word/1&x" },
    ]);
    assert.equal(patterns.mask(`echo ${TOKEN}`), "echo [API_TOKEN]");
    assert.equal(patterns.mask(`url?q=${encodeURIComponent("p@ss word/1&x")}`), "url?q=[DB_URL]");
    const encoded = Buffer.from(TOKEN).toString("base64");
    assert.notInclude(patterns.mask(`Authorization: Basic ${encoded}`), encoded.slice(0, 12));
    assert.include(patterns.mask(`Authorization: Basic ${encoded}`), "[API_TOKEN]");
  });

  it("finds base64 at any byte alignment inside a longer base64 text", () => {
    const patterns = makeSecretPatterns([{ name: "API_TOKEN", value: TOKEN }]);
    for (const prefix of ["", "a", "ab", "abc", "user:"]) {
      const encoded = Buffer.from(`${prefix}${TOKEN}:trailer`).toString("base64");
      const masked = patterns.mask(encoded);
      assert.include(masked, "[API_TOKEN]", `prefix ${JSON.stringify(prefix)}`);
    }
  });

  it("leaves values shorter than the threshold unmasked", () => {
    assert.equal(MIN_MASKED_SECRET_LENGTH, 6);
    const patterns = makeSecretPatterns([{ name: "PIN", value: "12345" }]);
    assert.isTrue(patterns.isEmpty);
    assert.equal(patterns.mask("pin 12345"), "pin 12345");
    assert.deepEqual(secretForms("12345"), []);
    assert.isFalse(makeSecretPatterns([{ name: "SIX", value: "123456" }]).isEmpty);
  });

  it("covers overlapping values as one mask, never leaving part of either", () => {
    const patterns = makeSecretPatterns([
      { name: "FIRST", value: "abcdef123" },
      { name: "SECOND", value: "def123456" },
    ]);
    const masked = patterns.mask("x abcdef123456 y");
    assert.equal(masked, "x [FIRST] y");
    // A value inside a longer one masks as the longer.
    const nested = makeSecretPatterns([
      { name: "SHORT", value: "token-1234" },
      { name: "LONG", value: "token-1234-extended" },
    ]);
    assert.equal(nested.mask("token-1234-extended"), "[LONG]");
    assert.equal(nested.mask("token-1234 alone"), "[SHORT] alone");
  });

  it("names a value two secrets share after the first one given", () => {
    const patterns = makeSecretPatterns([
      { name: "WINS", value: TOKEN },
      { name: "LOSES", value: TOKEN },
    ]);
    assert.equal(patterns.mask(TOKEN), "[WINS]");
  });

  it("tells when a chunk's end could be the start of a value", () => {
    const patterns = makeSecretPatterns([{ name: "API_TOKEN", value: TOKEN }]);
    assert.equal(patterns.pendingSuffix("output: sk-li"), 5);
    assert.equal(patterns.pendingSuffix("output: done\n"), 0);
    // A whole value is not pending: it masks now.
    assert.equal(patterns.pendingSuffix(`x ${TOKEN}`), 0);
    const first = `out ${TOKEN.slice(0, 7)}`;
    const held = patterns.pendingSuffix(first);
    assert.isAbove(held, 0);
    assert.equal(patterns.mask(first + TOKEN.slice(7)), "out [API_TOKEN]");
  });

  it("masks every string in plain objects and arrays, keeping other values and references", () => {
    const patterns = makeSecretPatterns([{ name: "API_TOKEN", value: TOKEN }]);
    const date = new (class Instant {
      readonly at = 0;
    })();
    const untouched = { a: "plain", b: [1, "x"], date };
    assert.strictEqual(maskDeep(untouched, patterns.mask), untouched);
    const masked = maskDeep(
      { text: `has ${TOKEN}`, nested: [{ output: TOKEN }], date, count: 3 },
      patterns.mask,
    );
    assert.deepEqual(masked, {
      text: "has [API_TOKEN]",
      nested: [{ output: "[API_TOKEN]" }],
      date,
      count: 3,
    });
    assert.strictEqual(masked.date, date);
  });

  it("masks base64url, wrapped base64, hex, \\u escapes, lower-case URL escapes and CRLF", () => {
    const value = "pässwörd/+?&=sk-0123456789";
    const patterns = makeSecretPatterns([{ name: "P", value }]);
    const bytes = Buffer.from(value);
    const base64url = bytes.toString("base64url");
    assert.include(patterns.mask(`t=${base64url}`), "[P]");
    assert.notInclude(patterns.mask(`t=${base64url}`), base64url.slice(4, 20));
    const wrapped = Buffer.from(`header:${value}:trailer`)
      .toString("base64")
      .replace(/(.{12})/g, "$1\n");
    assert.include(patterns.mask(wrapped), "[P]");
    assert.equal(patterns.mask(`x ${bytes.toString("hex")} y`), "x [P] y");
    assert.equal(patterns.mask(`x ${bytes.toString("hex").toUpperCase()} y`), "x [P] y");
    assert.equal(patterns.mask(`{"v":"p\\u00e4ssw\\u00f6rd/+?&=sk-0123456789"}`), `{"v":"[P]"}`);
    assert.equal(
      patterns.mask(encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase())),
      "[P]",
    );
    const pem = "-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9\n-----END KEY-----";
    const multi = makeSecretPatterns([{ name: "PEM", value: pem }]);
    assert.equal(multi.mask(`key:\r\n${pem.replace(/\n/g, "\r\n")}\r\n`), "key:\r\n[PEM]\r\n");
  });

  it("finds what is left of a value at the start of cut text", () => {
    const patterns = makeSecretPatterns([{ name: "API_TOKEN", value: TOKEN }]);
    assert.equal(patterns.pendingPrefix(`${TOKEN.slice(5)}\nnext`), TOKEN.length - 5);
    assert.equal(patterns.pendingPrefix("nothing here"), 0);
  });

  it("guards a stream: a held piece completes, a released one still masks its continuation", () => {
    const patterns = makeSecretPatterns([{ name: "API_TOKEN", value: TOKEN }]);
    const guard = new SecretStreamGuard(patterns);
    assert.deepEqual(guard.push(`out ${TOKEN.slice(0, 5)}`, 1024), { text: "", hold: true });
    assert.deepEqual(guard.push(`${TOKEN.slice(5)} done`, 1024), {
      text: "out [API_TOKEN] done",
      hold: false,
    });
    // Nothing followed in time: the start goes out, and the rest of the value never does.
    assert.deepEqual(guard.push(`next ${TOKEN.slice(0, 5)}`, 1024), { text: "", hold: true });
    assert.equal(guard.release(), `next ${TOKEN.slice(0, 5)}`);
    assert.deepEqual(guard.push(`${TOKEN.slice(5)}\r\n`, 1024), {
      text: "[API_TOKEN]\r\n",
      hold: false,
    });
  });

  it("never sends a start of a value raw: released, held too long or seeded", () => {
    const patterns = makeSecretPatterns([{ name: "API_TOKEN", value: TOKEN }]);
    const guard = new SecretStreamGuard(patterns);
    // Released after the hold: a start of 6 or more characters goes out as [NAME]...
    assert.deepEqual(guard.push(`a ${TOKEN.slice(0, 10)}`, 1024), { text: "", hold: true });
    assert.equal(guard.release(), "a [API_TOKEN]");
    // ...and the rest of the value, when it comes, is dropped (no second [NAME]).
    assert.deepEqual(guard.push(`${TOKEN.slice(10)} b`, 1024), { text: " b", hold: false });
    // More than may be held: the same.
    assert.deepEqual(guard.push(`${"x".repeat(20)}${TOKEN.slice(0, 8)}`, 16), {
      text: `${"x".repeat(20)}[API_TOKEN]`,
      hold: false,
    });
    assert.deepEqual(guard.push(TOKEN.slice(8), 16), { text: "", hold: false });
    // New values (a reload) keep what is held: the value split across it is masked whole.
    assert.deepEqual(guard.push(`c ${TOKEN.slice(0, 7)}`, 1024), { text: "", hold: true });
    guard.setPatterns(makeSecretPatterns([{ name: "API_TOKEN", value: TOKEN }]));
    assert.deepEqual(guard.push(`${TOKEN.slice(7)} d`, 1024), {
      text: "c [API_TOKEN] d",
      hold: false,
    });
    // A screen reset to text ending in a start: the rest, when it comes, is dropped.
    guard.seed(`$ cat key\r\n${TOKEN.slice(0, 9)}`);
    assert.deepEqual(guard.push(`${TOKEN.slice(9)}\r\n$ `, 1024), { text: "\r\n$ ", hold: false });
    assert.equal(
      maskWhole(patterns, `${TOKEN.slice(4)} and ${TOKEN.slice(0, 7)}`, { cutAtStart: true }),
      " and [API_TOKEN]",
    );
  });

  it("matches among thousands of values", () => {
    const many = Array.from({ length: 4000 }, (_, index) => ({
      name: `S${index}`,
      value: `value-${index.toString(36)}-${"x".repeat(12)}`,
    }));
    const patterns = makeSecretPatterns(many);
    const text = "an ordinary log line about nothing secret at all ".repeat(20);
    assert.equal(patterns.mask(text), text);
    assert.equal(patterns.mask(`a ${many[3999]!.value} b`), "a [S3999] b");
  });

  it("redacts the values this process was given, for logs and spans", () => {
    forgetKnownSecretsForTest();
    assert.equal(redactKnownSecrets(`log ${TOKEN}`), `log ${TOKEN}`);
    rememberKnownSecrets([
      { name: "API_TOKEN", value: TOKEN },
      { name: "PIN", value: "1234" },
    ]);
    assert.equal(redactKnownSecrets(`log ${TOKEN}`), "log [API_TOKEN]");
    assert.equal(redactKnownSecrets("pin 1234"), "pin 1234");
    forgetKnownSecretsForTest();
  });
});
