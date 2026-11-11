import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";

import { guestSessionCookieName } from "@t3tools/contracts";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import { parsePreviewOrigin } from "../preview/PreviewOrigin.ts";
import { guestSessionCookie, readSubmission } from "./http.ts";

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
  "reads the guest cookie as `__Host-`: none from a preview page, no bare one a preview could plant",
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
      // What a preview subdomain can set for the Hub's domain: a bare-named guest cookie.
      assert.equal(yield* read(`${name}=attacker-guest`, own), "");
      // A preview page's own requests carry none at all.
      const page = "https://abc.preview.example.test";
      assert.equal(yield* read(hostOnly, { origin: page }), "");
      assert.equal(yield* read(hostOnly, { referer: `${page}/` }), "");
      // Without previews on their own origin, a guest from before keeps their bare cookie.
      assert.equal(yield* read(`${name}=guest-token`, own, false), "guest-token");
    }),
);
