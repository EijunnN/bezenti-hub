import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { hostedThreadLink, hubLinkOrigin, parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { expect, it } from "vite-plus/test";

import { registerEnvironmentHubOrigins } from "./hubOrigins.ts";

const thread = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t-1") };

it("reads links copied from a connected environment back as thread links, on either address", () => {
  const lan = "http://192.168.1.4:3773";
  const publicUrl = "https://hub-registered.example.com";
  const copiedOnLan = hostedThreadLink(thread, hubLinkOrigin({ currentOrigin: `${lan}/` })!);
  const copiedPublic = hostedThreadLink(thread, hubLinkOrigin({ publicUrl, currentOrigin: lan })!);
  expect(parseThreadLinkHref(copiedOnLan)).toBeNull();
  expect(parseThreadLinkHref(copiedPublic)).toBeNull();

  registerEnvironmentHubOrigins({ publicUrl, httpBaseUrl: `${lan}/` });

  expect(parseThreadLinkHref(copiedOnLan)).toEqual(thread);
  expect(parseThreadLinkHref(copiedPublic)).toEqual(thread);
  expect(parseThreadLinkHref("https://other.example.com/threads/env-1/t-1")).toBeNull();
});

it("ignores addresses that are not http origins", () => {
  registerEnvironmentHubOrigins({ publicUrl: null, httpBaseUrl: "t3code://app" });
  expect(parseThreadLinkHref("t3code://app/threads/env-1/t-1")).toBeNull();
});
