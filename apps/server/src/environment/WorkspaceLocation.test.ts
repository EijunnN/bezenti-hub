import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, HUB_MACHINE_ENVIRONMENT_ID, ProjectId } from "@t3tools/contracts";

import {
  locateInCheckout,
  projectCheckoutSlug,
  resolveOnEnvironment,
  type WorkspaceLocation,
} from "./WorkspaceLocation.ts";

const hub = HUB_MACHINE_ENVIRONMENT_ID;
const projectId = ProjectId.make("project:web");
const host = (path: string): WorkspaceLocation => ({ base: "host", environmentId: hub, path });

describe("locateInCheckout", () => {
  it.each([
    ["/srv/web", "/srv/web/packages/app", { base: "checkout", path: "packages/app" }],
    ["/srv/web/", "/srv/web/packages", { base: "checkout", path: "packages" }],
    ["/srv/web", "/srv/web", { base: "checkout", path: "." }],
    ["/", "/srv", { base: "checkout", path: "srv" }],
    ["C:\\Users\\ana\\web", "C:\\Users\\ana\\web\\src\\app", { base: "checkout", path: "src/app" }],
    ["C:\\", "C:\\web", { base: "checkout", path: "web" }],
    ["/srv/web", "/srv/web-old", host("/srv/web-old")],
    ["/srv/web", "/srv/web/../etc", host("/srv/web/../etc")],
    ["/srv/web", "/srv/web//app", host("/srv/web//app")],
    // A backslash is a filename character on POSIX, so it must not become a separator.
    ["/srv/web", "/srv/web\\app", host("/srv/web\\app")],
    ["C:\\web", "C:\\web/app", host("C:\\web/app")],
    [null, "/srv/web/app", host("/srv/web/app")],
  ] as const)("%s holds %s as %j", (checkout, absolute, expected) => {
    const location = locateInCheckout({ environmentId: hub, checkout, absolute });
    expect(location).toEqual(expected);
    // On the machine that recorded it, every location resolves back to the exact same string.
    expect(resolveOnEnvironment({ environmentId: hub, projectId, checkout, location })).toBe(
      absolute,
    );
  });

  it("resolves on another machine against that machine's checkout, in its own separators", () => {
    const laptop = EnvironmentId.make("environment:laptop");
    const location = locateInCheckout({
      environmentId: hub,
      checkout: "/srv/web",
      absolute: "/srv/web/packages/app",
    });
    expect(
      resolveOnEnvironment({
        environmentId: laptop,
        projectId,
        checkout: "D:\\code\\web",
        location,
      }),
    ).toBe("D:\\code\\web\\packages\\app");
    const elsewhere = resolveOnEnvironment({
      environmentId: laptop,
      projectId,
      checkout: "/home/ana/web",
      location: host("/srv/hub-only"),
    });
    expect(typeof elsewhere === "string" ? elsewhere : elsewhere._tag).toBe(
      "WorkspaceLocationUnavailableError",
    );
  });
});

describe("projectCheckoutSlug", () => {
  it.each([
    ["/srv/web", "web"],
    ["C:\\Users\\ana\\My Project\\", "My-Project"],
    ["/srv/.hidden", "hidden"],
    [null, "project-web"],
  ] as const)("%s → %s", (hubCheckout, slug) => {
    expect(projectCheckoutSlug({ projectId, hubCheckout })).toBe(slug);
  });
});
