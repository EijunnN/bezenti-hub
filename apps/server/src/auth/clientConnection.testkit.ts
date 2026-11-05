import * as Option from "effect/Option";

import { layerClientAdmission } from "./clientAdmission.ts";
import { DEFAULT_TRUSTED_PROXIES } from "./clientConnection.ts";

/** Names the direct peer of a test request; a web `Request` has no socket to read it from. */
export const TEST_PEER_HEADER = "x-test-peer";

/**
 * The served client rules for routes under test, run on the peer the request names (loopback
 * unless it names one), with the default trusted proxies.
 */
export const layerTestPeer = layerClientAdmission(DEFAULT_TRUSTED_PROXIES, (request) =>
  request.modify({
    remoteAddress: Option.some(request.headers[TEST_PEER_HEADER] ?? "127.0.0.1"),
  }),
);
