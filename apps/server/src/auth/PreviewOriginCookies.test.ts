/**
 * Previews on their own origin (spec 3 ticket 15): a page at `<id>.preview.<domain>` is same-site
 * with the Hub, so `SameSite` does not keep the Hub's session cookie from it. These are the Hub's
 * own rules for that: a request that came from a preview origin is not signed in at any door, and
 * over HTTPS the session cookie is `__Host-`, which no preview subdomain can set or shadow.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { hubWithOwner } from "../environments/environments.testkit.ts";
import { parsePreviewOrigin } from "../preview/PreviewOrigin.ts";

const parsed = parsePreviewOrigin("https://*.preview.example.test");
if (Result.isFailure(parsed)) throw new Error(parsed.failure);
const PREVIEWS = parsed.success;
/** A page on a preview's own origin. */
const PREVIEW_PAGE =
  "https://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst.preview.example.test";

const HTTPS = { "x-forwarded-proto": "https" };
const tokenOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);
const nameOf = (cookie: string) => cookie.slice(0, cookie.indexOf("="));

describe("a page on a preview's own origin is never signed in to the Hub", () => {
  it.effect("whether it names its origin, its address, or nothing at all", () =>
    Effect.gen(function* () {
      const { server, owner } = yield* hubWithOwner({ previewOrigin: PREVIEWS });
      assert.equal((yield* server.request("/api/spaces", { cookie: owner })).status, 200);

      // A script on the page calling the Hub: its Origin is the preview's.
      const fetched = yield* server.request("/api/spaces", {
        cookie: owner,
        headers: { origin: PREVIEW_PAGE, "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" },
      });
      assert.equal(fetched.status, 401);
      // A form it posts to the Hub (CSRF): no Organization is made in the Owner's name.
      const posted = yield* server.request("/api/spaces/organizations", {
        cookie: owner,
        body: { name: "Tossed" },
        headers: { origin: PREVIEW_PAGE, "sec-fetch-site": "same-site" },
      });
      assert.equal(posted.status, 401);
      // Only a Referer: what a browser sends for a subresource, which carries no Origin.
      const referred = yield* server.request("/api/spaces", {
        cookie: owner,
        omitOrigin: true,
        headers: { referer: `${PREVIEW_PAGE}/src/main.ts` },
      });
      assert.equal(referred.status, 401);
      // Neither: an `<img>`, a `<script>` or an `<iframe>` with `referrerpolicy="no-referrer"`,
      // which a same-site page sends with the Hub's SameSite=Lax cookie.
      for (const [mode, dest] of [
        ["no-cors", "image"],
        ["no-cors", "script"],
        ["navigate", "iframe"],
      ] as const) {
        const embedded = yield* server.request("/api/spaces", {
          cookie: owner,
          omitOrigin: true,
          headers: {
            "sec-fetch-site": "same-site",
            "sec-fetch-mode": mode,
            "sec-fetch-dest": dest,
          },
        });
        assert.equal(embedded.status, 401, `${mode} ${dest}`);
      }
      // The session check says signed out too, and sends no cookie back.
      const session = yield* server.request("/api/auth/session", {
        cookie: owner,
        headers: { origin: PREVIEW_PAGE },
      });
      assert.equal(session.body.authenticated, false);
      assert.isUndefined(session.setCookie);

      // A link on that page to the Hub is any site's link: the Hub's own page loads signed in.
      const linked = yield* server.request("/api/spaces", {
        cookie: owner,
        omitOrigin: true,
        headers: {
          "sec-fetch-site": "same-site",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      });
      assert.equal(linked.status, 200);
      // And the Hub's own pages, from its own origin, are untouched.
      const own = yield* server.request("/api/spaces", {
        cookie: owner,
        headers: { "sec-fetch-site": "same-origin", referer: "http://127.0.0.1/settings" },
      });
      assert.equal(own.status, 200);
    }),
  );

  it.effect("without previews on their own origin, the Hub's checks are as before", () =>
    Effect.gen(function* () {
      const { server, owner } = yield* hubWithOwner();
      const referred = yield* server.request("/api/spaces", {
        cookie: owner,
        omitOrigin: true,
        headers: { referer: `${PREVIEW_PAGE}/src/main.ts` },
      });
      assert.equal(referred.status, 200);
      const embedded = yield* server.request("/api/spaces", {
        cookie: owner,
        omitOrigin: true,
        headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" },
      });
      assert.equal(embedded.status, 200);
    }),
  );
});

describe("over HTTPS the Hub's session cookie is one no other host can set", () => {
  it.effect("it is `__Host-`, host-only and Secure, and a session from before moves to it", () =>
    Effect.gen(function* () {
      const { server, owner } = yield* hubWithOwner();
      // A browser holding the bare cookie from before: still signed in, and moved over.
      const checked = yield* server.request("/api/auth/session", { cookie: owner, headers: HTTPS });
      assert.equal(checked.body.authenticated, true);
      const moved = checked.setCookie;
      assert.isDefined(moved);
      assert.equal(nameOf(moved!), `__Host-${nameOf(owner)}`);
      assert.match(moved!, /;\s*Secure/i);
      assert.match(moved!, /;\s*Path=\/(;|$)/i);
      assert.match(moved!, /;\s*HttpOnly/i);
      assert.notMatch(moved!, /;\s*Domain=/i);
      // The bare one is expired in the same answer, so the browser keeps only the `__Host-` one.
      const bare = checked.setCookies.find((cookie) => cookie.startsWith(`${nameOf(owner)}=`));
      assert.isDefined(bare);
      assert.match(bare!, /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
      const again = yield* server.request("/api/auth/session", {
        cookie: checked.cookie!,
        headers: HTTPS,
      });
      assert.equal(again.body.authenticated, true);
      // Signing out clears both names.
      const out = yield* server.request("/api/auth/sign-out", {
        body: {},
        cookie: checked.cookie!,
        headers: HTTPS,
      });
      assert.equal(out.status, 200);
      const cleared = out.setCookies.map(nameOf);
      assert.includeMembers(cleared, [nameOf(owner), `__Host-${nameOf(owner)}`]);
    }),
  );

  it.effect(
    "with previews on their own origin, a bare-named cookie over HTTPS counts for nothing (tossed)",
    () =>
      Effect.gen(function* () {
        const { server, owner } = yield* hubWithOwner({ previewOrigin: PREVIEWS });
        // What a preview subdomain can set with `Domain=<the Hub's domain>`: the bare name, here
        // with a real session's token (an attacker's own, to sign the victim in as them).
        const tossed = yield* server.request("/api/auth/session", {
          cookie: owner,
          headers: HTTPS,
        });
        assert.equal(tossed.body.authenticated, false);
        assert.isUndefined(tossed.setCookie);
        assert.equal(
          (yield* server.request("/api/spaces", { cookie: owner, headers: HTTPS })).status,
          401,
        );
        // The `__Host-` cookie, which only the Hub's own host can set, is the session.
        const hostCookie = `__Host-${nameOf(owner)}=${tokenOf(owner)}`;
        const signedIn = yield* server.request("/api/auth/session", {
          cookie: hostCookie,
          headers: HTTPS,
        });
        assert.equal(signedIn.body.authenticated, true);
        // Plain HTTP (a loopback Hub) cannot hold a `__Host-` cookie: the bare one still counts.
        assert.equal((yield* server.request("/api/spaces", { cookie: owner })).status, 200);
      }),
  );
});

describe("a page on a preview's own origin cannot sign a browser in to the Hub", () => {
  it.effect(
    "no door sets the Hub's session cookie for it (login CSRF), and it signs nobody out",
    () =>
      Effect.gen(function* () {
        const { server, owner } = yield* hubWithOwner({ previewOrigin: PREVIEWS });
        // An attacker's own pairing link, redeemed by a script on the preview page in the
        // victim's browser: the browser would hold the attacker's session for the Hub.
        const pairing = yield* server.request("/api/auth/pairing-token", {
          body: {},
          cookie: owner,
        });
        assert.equal(pairing.status, 200);
        const redeemed = yield* server.request("/api/auth/browser-session", {
          body: { credential: pairing.body.credential },
          headers: { origin: PREVIEW_PAGE, "sec-fetch-site": "same-site" },
        });
        assert.deepEqual(
          redeemed.setCookies.filter((cookie) => cookie.includes("t3_session")),
          [],
        );
        // Nor does it sign the browser out of the Hub.
        const out = yield* server.request("/api/auth/sign-out", {
          body: {},
          cookie: owner,
          headers: { origin: PREVIEW_PAGE, "sec-fetch-site": "same-site" },
        });
        assert.deepEqual(
          out.setCookies.filter((cookie) => cookie.includes("t3_session")),
          [],
        );
        assert.equal((yield* server.request("/api/spaces", { cookie: owner })).status, 200);
        // From the Hub's own page such a link signs in.
        const another = yield* server.request("/api/auth/pairing-token", {
          body: {},
          cookie: owner,
        });
        const own = yield* server.request("/api/auth/browser-session", {
          body: { credential: another.body.credential },
        });
        assert.equal(own.status, 200);
        assert.isDefined(own.setCookie);
      }),
  );
});
