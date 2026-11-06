import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { Route } from "./_chat.$environmentId.$threadId";

describe("the old /$environmentId/$threadId route", () => {
  it("redirects to the Thread's own route before loading, keeping the search", () => {
    let thrown: unknown;
    try {
      (Route.options.beforeLoad as (input: unknown) => void)({
        params: { environmentId: "env-1", threadId: "thread-1" },
        search: { panel: "diff" },
      });
    } catch (error) {
      thrown = error;
    }
    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: unknown }).options).toMatchObject({
      to: "/$threadId",
      params: { threadId: "thread-1" },
      search: { panel: "diff" },
      replace: true,
    });
  });
});
