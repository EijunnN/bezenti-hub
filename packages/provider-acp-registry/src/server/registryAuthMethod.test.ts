import { describe, expect, it } from "@effect/vitest";

import { registryAuthMethod } from "./adapter.ts";

describe("registryAuthMethod (spec 4 ticket 07)", () => {
  it("asks for the instance's stored sign-in method on a turn of its own", () => {
    expect(registryAuthMethod({ authMethodId: "devin-login" }, {})).toEqual({
      authMethodId: "devin-login",
    });
  });

  it("never asks for it on a Hub turn on a direct AI account: the token signs in", () => {
    expect(
      registryAuthMethod({ authMethodId: "devin-login" }, { aiCredential: "DEVIN_TOKEN" }),
    ).toEqual({});
  });
});
