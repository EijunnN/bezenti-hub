import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  UserId,
  withoutInstallationScopes,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpRouter } from "effect/http";
import { OtlpSerialization } from "effect/observability";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import { layerOtlpTracesProxyRoute } from "./http.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as SpaceVisibility from "./spaces/SpaceVisibility.ts";

const span = {
  resourceSpans: [
    {
      resource: { attributes: [] },
      scopeSpans: [
        {
          scope: { name: "web" },
          spans: [
            {
              traceId: "0af7651916cd43dd8448eb211c80319c",
              spanId: "b7ad6b7169203331",
              name: "click",
              kind: 1,
              startTimeUnixNano: "1",
              endTimeUnixNano: "2",
              attributes: [],
              status: { code: 0 },
            },
          ],
        },
      ],
    },
  ],
};

it.effect("only the Owner's clients write to the Installation's trace collector", () =>
  Effect.gen(function* () {
    const recorded: Array<string> = [];
    const asUser = (userId: string, owner: boolean) => {
      const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
        authenticateHttpRequest: () =>
          Effect.succeed({
            sessionId: AuthSessionId.make(`session-${userId}`),
            subject: "user-sign-in",
            method: "browser-session-cookie",
            userId: UserId.make(userId),
            scopes: owner
              ? AuthStandardClientScopes
              : withoutInstallationScopes(AuthStandardClientScopes),
          }),
      });
      const visibility = Layer.succeed(
        SpaceVisibility.SpaceVisibility,
        SpaceVisibility.SpaceVisibility.of({
          of: () =>
            Effect.succeed(owner ? SpaceVisibility.everything : { all: false, spaceIds: [] }),
        } as never),
      );
      return HttpRouter.toWebHandler(
        layerOtlpTracesProxyRoute.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              auth,
              visibility,
              Layer.succeed(
                BrowserTraceCollector.BrowserTraceCollector,
                BrowserTraceCollector.BrowserTraceCollector.of({
                  record: () => Effect.sync(() => recorded.push(userId)),
                }),
              ),
              Layer.succeed(HttpClient.HttpClient, {} as HttpClient.HttpClient),
              OtlpSerialization.layerJson,
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-otlp-" }),
            ),
          ),
          Layer.provideMerge(NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer))),
        ),
        { disableLogger: true },
      );
    };
    const post = (handler: ReturnType<typeof asUser>, body: string) =>
      Effect.promise(() =>
        handler.handler(
          new Request("http://t3.test/api/observability/v1/traces", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        ),
      );
    const member = asUser("grace", false);
    const owner = asUser("owner", true);
    try {
      expect((yield* post(member, JSON.stringify(span))).status).toBe(204);
      expect(recorded).toEqual([]);
      expect((yield* post(owner, JSON.stringify(span))).status).toBe(204);
      expect(recorded).toEqual(["owner"]);
      // Over the limit, even the Owner's are dropped.
      const huge = JSON.stringify({ ...span, padding: "x".repeat(5 * 1024 * 1024) });
      expect((yield* post(owner, huge)).status).toBe(204);
      expect(recorded).toEqual(["owner"]);
    } finally {
      yield* Effect.promise(() => member.dispose());
      yield* Effect.promise(() => owner.dispose());
    }
  }),
);
