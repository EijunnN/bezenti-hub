import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";

import { guestSessionCookieName } from "@t3tools/contracts";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import { parsePreviewOrigin } from "../preview/PreviewOrigin.ts";
import { guestPostAllowed, guestSessionCookie, readSubmission } from "./http.ts";

it.effect("keeps a JSON file a guest attaches as a file, not a form field", () =>
  Effect.gen(function* () {
    const form = new FormData();
    form.append("shareId", "share-1");
    form.append("text", "");
    form.append("file", new File(['{"a":1}'], "data.json", { type: "application/json" }));
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost/api/guest/messages?share=share-1", {
        method: "POST",
        body: form,
      }),
    );
    const submission = yield* readSubmission.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );
    assert.deepEqual(
      submission?.uploads.map((upload) => [upload.name, upload.contentType]),
      [["data.json", "application/json"]],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "reads the guest cookie, `__Host-` first: none from a preview page, the bare one from before",
  () =>
    Effect.gen(function* () {
      const parsed = parsePreviewOrigin("https://*.preview.example.test");
      assert.isTrue(Result.isSuccess(parsed));
      const previewOrigin = Result.isSuccess(parsed) ? parsed.success : undefined;
      const name = guestSessionCookieName("share-1");
      const read = (cookie: string, headers: Record<string, string>, withPreviews = true) =>
        guestSessionCookie(
          HttpServerRequest.fromWeb(
            new Request("https://hub.example.test/api/guest/messages?share=share-1", {
              method: "POST",
              headers: { cookie, ...headers },
            }),
          ).modify({ protocol: "https" }),
          "share-1",
        ).pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            previewOrigin: withPreviews ? previewOrigin : undefined,
          } as unknown as ServerConfig.ServerConfig["Service"]),
        );
      const own = { origin: "https://hub.example.test" };
      const hostOnly = `__Host-${name}=guest-token`;
      assert.equal(yield* read(hostOnly, own), "guest-token");
      // A guest from before, with the bare-named cookie, stays in (the session check moves it to
      // `__Host-`); one a preview planted could only carry a token the Hub gave some guest.
      assert.equal(yield* read(`${name}=guest-token`, own), "guest-token");
      assert.equal(
        yield* read(`${name}=guest-token`, { origin: "null", "sec-fetch-site": "same-site" }),
        "",
      );
      // A preview page's own requests carry none at all.
      const page = "https://abc.preview.example.test";
      assert.equal(yield* read(hostOnly, { origin: page }), "");
      assert.equal(yield* read(hostOnly, { referer: `${page}/` }), "");
      // Without previews on their own origin, a guest from before keeps their bare cookie.
      assert.equal(yield* read(`${name}=guest-token`, own, false), "guest-token");
    }),
);

it.effect("takes a guest's POST only from the Hub's own page, and a redemption only as JSON", () =>
  Effect.gen(function* () {
    const allowed = (headers: Record<string, string>, json: boolean) =>
      guestPostAllowed(
        HttpServerRequest.fromWeb(
          new Request("https://hub.example.test/api/guest/messages?share=share-1", {
            method: "POST",
            headers: { host: "hub.example.test", ...headers },
          }),
        ).modify({ protocol: "https" }),
        { json },
      ).pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          publicUrl: new URL("https://hub.example.test"),
          devUrl: undefined,
        } as unknown as ServerConfig.ServerConfig["Service"]),
      );
    const own = { origin: "https://hub.example.test" };
    assert.isTrue(yield* allowed(own, false));
    assert.isTrue(yield* allowed({ ...own, "content-type": "application/json" }, true));
    // The Hub at another of its addresses, behind a proxy that rewrites Host: the browser says
    // same-origin.
    assert.isTrue(
      yield* allowed({ origin: "http://127.0.0.1:6049", "sec-fetch-site": "same-origin" }, false),
    );
    assert.isFalse(
      yield* allowed({ origin: "http://127.0.0.1:6049", "sec-fetch-site": "same-site" }, false),
    );
    // A `no-cors` post from any page (`Origin: null`), one naming no Origin, another site's.
    assert.isFalse(yield* allowed({ origin: "null" }, false));
    assert.isFalse(yield* allowed({ origin: "null", "sec-fetch-site": "same-origin" }, false));
    assert.isFalse(yield* allowed({}, false));
    assert.isFalse(yield* allowed({ origin: "https://abc.preview.example.test" }, false));
    // A redemption as `text/plain`, the content type a `no-cors` request may carry.
    assert.isFalse(yield* allowed({ ...own, "content-type": "text/plain" }, true));
  }),
);
