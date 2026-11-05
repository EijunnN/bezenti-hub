import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import { DEFAULT_TRUSTED_PROXIES, withClientConnection } from "./clientConnection.ts";

/** Names the direct peer of a test request; a web `Request` has no socket to read it from. */
export const TEST_PEER_HEADER = "x-test-peer";

/**
 * The served client-connection rules for routes under test, run on the peer the request names
 * (loopback unless it names one), with the default trusted proxies.
 */
export const layerTestPeer = HttpRouter.middleware(
  (httpApp) =>
    Effect.updateService(httpApp, HttpServerRequest.HttpServerRequest, (request) =>
      withClientConnection(
        request.modify({
          remoteAddress: Option.some(request.headers[TEST_PEER_HEADER] ?? "127.0.0.1"),
        }),
        DEFAULT_TRUSTED_PROXIES,
      ),
    ),
  { global: true },
);
