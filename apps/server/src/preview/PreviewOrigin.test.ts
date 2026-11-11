import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/http";

import {
  crossesFromPreviewOrigin,
  inPreviewZone,
  newPreviewId,
  parsePreviewOrigin,
  previewHostOf,
  previewOriginOf,
  readHubCookie,
} from "./PreviewOrigin.ts";

const parse = (value: string, hub?: Parameters<typeof parsePreviewOrigin>[1]) => {
  const parsed = parsePreviewOrigin(value, hub);
  if (Result.isFailure(parsed)) throw new Error(parsed.failure);
  return parsed.success;
};
const refusal = (value: string, hub?: Parameters<typeof parsePreviewOrigin>[1]) => {
  const parsed = parsePreviewOrigin(value, hub);
  assert.isTrue(Result.isFailure(parsed), value);
  return Result.isFailure(parsed) ? parsed.failure : "";
};

describe("T3CODE_PREVIEW_ORIGIN", () => {
  it("is a wildcard over a domain of its own, https, or http under localhost", () => {
    assert.deepEqual(parse("https://*.preview.example.com"), {
      protocol: "https:",
      zone: "preview.example.com",
      port: "",
    });
    assert.deepEqual(parse("HTTPS://*.Preview.Example.com:443/"), {
      protocol: "https:",
      zone: "preview.example.com",
      port: "",
    });
    assert.deepEqual(parse("http://*.localhost:3773"), {
      protocol: "http:",
      zone: "localhost",
      port: "3773",
    });
    assert.match(refusal("https://preview.example.com"), /wildcard origin/);
    assert.match(refusal("https://*.*.example.com"), /not a host name/);
    assert.match(refusal("https://x.*.example.com"), /wildcard origin/);
    assert.match(refusal("https://*.com"), /domain of its own/);
    assert.match(refusal("http://*.preview.example.com"), /must be https/);
    assert.match(refusal("https://*.preview.example.com/path"), /wildcard origin/);
  });

  it("never covers the Hub's own host", () => {
    const hub = { publicUrl: new URL("https://abc.preview.example.com") };
    assert.match(refusal("https://*.preview.example.com", hub), /Hub's own host/);
    assert.match(refusal("https://*.example.com", hub), /Hub's own host/);
    assert.match(
      refusal("https://*.example.com", { host: "hub.example.com" }),
      /Hub's own host abc|Hub's own host hub/,
    );
    // The Hub at the zone's parent is outside the zone (same-site: see the docs).
    parse("https://*.hub.example.com", { publicUrl: new URL("https://hub.example.com") });
  });
});

describe("a host under the preview zone", () => {
  const pattern = parse("https://*.preview.example.com");
  const id = newPreviewId();

  it("is a preview's own origin only as exactly its subdomain, scheme and port", () => {
    assert.match(id, /^[a-z2-7]{52}$/);
    assert.notEqual(newPreviewId(), id);
    assert.deepEqual(previewHostOf(pattern, new URL(`https://${id}.preview.example.com/x`)), {
      id,
    });
    assert.deepEqual(
      previewHostOf(pattern, new URL(`https://${id.toUpperCase()}.Preview.Example.com`)),
      {
        id,
      },
    );
    // In the zone, but no preview's: answered as unknown, never by the Hub.
    for (const host of [
      `https://hub.preview.example.com`,
      `https://a.${id}.preview.example.com`,
      `http://${id}.preview.example.com`,
      `https://${id}.preview.example.com:8443`,
    ]) {
      assert.deepEqual(previewHostOf(pattern, new URL(host)), { id: undefined }, host);
    }
    // Outside it: the Hub's own routes.
    for (const host of [
      "https://preview.example.com",
      "https://example.com",
      `https://${id}.preview.example.com.evil.test`,
      `https://${id}preview.example.com`,
    ]) {
      assert.isUndefined(previewHostOf(pattern, new URL(host)), host);
    }
    assert.equal(previewOriginOf(pattern, id), `https://${id}.preview.example.com`);
    assert.equal(
      previewOriginOf(parse("http://*.localhost:3773"), id),
      `http://${id}.localhost:3773`,
    );
    assert.isTrue(inPreviewZone(pattern, "x.preview.example.com."));
  });

  it("marks a request that came from a preview page by its Origin or Referer, nothing else", () => {
    const page = `https://${id}.preview.example.com`;
    assert.isTrue(crossesFromPreviewOrigin(pattern, { origin: page }));
    assert.isTrue(crossesFromPreviewOrigin(pattern, { referer: `${page}/src/main.ts` }));
    // `Origin: null` from another site or a sibling (a `no-cors` fetch with `no-referrer`): no
    // way to tell it from a preview page, so it is one.
    assert.isTrue(
      crossesFromPreviewOrigin(pattern, { origin: "null", "sec-fetch-site": "same-site" }),
    );
    assert.isTrue(
      crossesFromPreviewOrigin(pattern, { origin: "null", "sec-fetch-site": "cross-site" }),
    );
    // A same-site caller that names neither (the dev web app's `<img>`), the Hub's own pages, a
    // top-level link, and other sites' requests are not.
    assert.isFalse(
      crossesFromPreviewOrigin(pattern, {
        "sec-fetch-site": "same-site",
        "sec-fetch-dest": "image",
      }),
    );
    assert.isFalse(
      crossesFromPreviewOrigin(pattern, {
        origin: "https://hub.example.com",
        "sec-fetch-site": "same-origin",
      }),
    );
    assert.isFalse(crossesFromPreviewOrigin(pattern, { origin: "null" }));
    assert.isFalse(crossesFromPreviewOrigin(pattern, {}));
    // Without previews on their own origin, nothing is.
    assert.isFalse(crossesFromPreviewOrigin(undefined, { origin: page, referer: page }));
  });

  it("reads every Hub cookie in one way: `__Host-` first, a bare one only where none could be planted", () => {
    const page = `https://${id}.preview.example.com`;
    const request = (
      cookies: Record<string, string>,
      protocol: "http" | "https",
      headers: Record<string, string> = {},
    ) =>
      HttpServerRequest.fromWeb(
        new Request(`${protocol}://hub.example.com/api/x`, {
          headers: {
            cookie: Object.entries(cookies)
              .map(([name, value]) => `${name}=${value}`)
              .join("; "),
            ...headers,
          },
        }),
      ).modify({ protocol });
    const both = { "__Host-t3_guest_s": "hub", t3_guest_s: "tossed" };
    assert.equal(readHubCookie(request(both, "https"), "t3_guest_s", pattern), "hub");
    // Previews on, HTTPS: a bare cookie may be a preview's, for the Hub's domain.
    assert.isUndefined(
      readHubCookie(request({ t3_guest_s: "tossed" }, "https"), "t3_guest_s", pattern),
    );
    // Plain HTTP holds no `__Host-` cookie; previews off, nothing could plant one.
    assert.equal(readHubCookie(request({ t3_guest_s: "x" }, "http"), "t3_guest_s", pattern), "x");
    assert.equal(
      readHubCookie(request({ t3_guest_s: "x" }, "https"), "t3_guest_s", undefined),
      "x",
    );
    // From a page on a preview's own origin, none at all.
    assert.isUndefined(
      readHubCookie(request(both, "https", { origin: page }), "t3_guest_s", pattern),
    );
  });
});
