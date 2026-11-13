import { assert, describe, it } from "@effect/vitest";

import {
  forgetKnownSecretsForTest,
  makeSecretPatterns,
  maskDeep,
  MIN_MASKED_SECRET_LENGTH,
  redactKnownSecrets,
  rememberKnownSecrets,
  secretForms,
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
