// @effect-diagnostics nodeBuiltinImport:off - reads the server's own sources to list its doors.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { EnvironmentHttpApi } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as HttpApi from "effect/http-api/HttpApi";
import { Tool } from "effect/ai";

import {
  AMBIENT_COOKIE_RULES,
  HTTP_ENDPOINT_RULES,
  MCP_TOOL_RULES,
  RAW_ROUTE_RULES,
} from "./DoorRules.ts";
import { spaceAccessForRpcMethod } from "./RpcSpaceAccess.ts";

const SRC = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const sources = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") && !/\.test(kit)?\.ts$|\.testkit\.ts$/.test(entry.name)
      ? [full]
      : [];
  });

const files = sources(SRC).map((file) => ({
  file: NodePath.relative(SRC, file).replaceAll("\\", "/"),
  text: NodeFS.readFileSync(file, "utf8"),
}));

/** `METHOD path` of every raw route, as its source names it (`file: METHOD path`). */
const rawRoutes = files.flatMap(({ file, text }) => [
  ...Array.from(
    text.matchAll(/\.add\(\s*"(GET|POST|PUT|DELETE|PATCH|HEAD|\*)",\s*([^,\n]+),/g),
    (match) => `${file}: ${match[1]} ${match[2]!.trim()}`,
  ),
  ...Array.from(
    text.matchAll(/McpServer\.layerHttp\(\{[^}]*?path:\s*("[^"]+")/gs),
    (match) => `${file}: * ${match[1]}`,
  ),
  // A global middleware sees every request before any route, and may answer it itself.
  ...(/HttpRouter\.middleware\(/.test(text) ? [`${file}: middleware`] : []),
]);

// Every module that makes MCP tools, loaded: the tool names come from the Tool objects themselves.
const toolModules = files.filter(({ text }) => /Tool\.make\(/.test(text));
const mcpTools = (
  await Promise.all(
    toolModules.map(({ file }) => import(NodeURL.pathToFileURL(NodePath.join(SRC, file)).href)),
  )
).flatMap((module: Record<string, unknown>) =>
  Object.values(module).flatMap((value) => {
    if (Tool.isUserDefined(value)) return [value.name];
    const tools = (value as { readonly tools?: unknown } | null)?.tools;
    return tools !== null && typeof tools === "object"
      ? Object.values(tools).flatMap((tool) => (Tool.isUserDefined(tool) ? [tool.name] : []))
      : [];
  }),
);

const endpoints = (() => {
  const found: Array<string> = [];
  HttpApi.reflect(EnvironmentHttpApi, {
    onGroup: () => undefined,
    onEndpoint: ({ group, endpoint }) => found.push(`${group.identifier}.${endpoint.identifier}`),
  });
  return found;
})();

const undeclared = (doors: ReadonlyArray<string>, rules: Readonly<Record<string, unknown>>) =>
  [...new Set(doors)].filter((door) => !Object.hasOwn(rules, door)).toSorted();
const stale = (doors: ReadonlyArray<string>, rules: Readonly<Record<string, unknown>>) =>
  Object.keys(rules)
    .filter((door) => !doors.includes(door))
    .toSorted();

describe("every door of the Hub declares its rule", () => {
  it("lists every HTTP endpoint, raw route and MCP tool in DoorRules", () => {
    expect(endpoints.length).toBeGreaterThan(50);
    expect(rawRoutes.length).toBeGreaterThan(10);
    expect(mcpTools.length).toBeGreaterThan(50);
    expect({
      endpoints: undeclared(endpoints, HTTP_ENDPOINT_RULES),
      rawRoutes: undeclared(rawRoutes, RAW_ROUTE_RULES),
      mcpTools: undeclared(mcpTools, MCP_TOOL_RULES),
    }).toEqual({ endpoints: [], rawRoutes: [], mcpTools: [] });
    // A door that is gone leaves no entry behind.
    expect({
      endpoints: stale(endpoints, HTTP_ENDPOINT_RULES),
      rawRoutes: stale(rawRoutes, RAW_ROUTE_RULES),
      mcpTools: stale(mcpTools, MCP_TOOL_RULES),
    }).toEqual({ endpoints: [], rawRoutes: [], mcpTools: [] });
  });

  it("names, for a door that shares an RPC's rule, an RPC that has one", () => {
    const twins = [
      ...Object.values(HTTP_ENDPOINT_RULES),
      ...Object.values(RAW_ROUTE_RULES),
      ...Object.values(MCP_TOOL_RULES),
    ].flatMap((rule) => ("rpc" in rule ? [rule.rpc] : []));
    expect(twins.filter((method) => spaceAccessForRpcMethod(method) === undefined)).toEqual([]);
  });

  it("reaches the Owner's SSH install only through its HTTP endpoints: no WS or MCP door", () => {
    const users = files
      .filter(({ text }) => /sshInstall\/SshInstall\.ts"/u.test(text))
      .map(({ file }) => file);
    // server.ts builds its layer; environments/http.ts is its one door.
    expect(users.toSorted()).toEqual(["environments/http.ts", "server.ts"]);
    const doors = Object.keys(HTTP_ENDPOINT_RULES).filter((name) => /ssh/iu.test(name));
    expect(doors.toSorted()).toEqual([
      "environments.sshInstallCancel",
      "environments.sshInstallConfirm",
      "environments.sshInstallStart",
      "environments.sshInstallStatus",
    ]);
    expect(
      [...Object.keys(MCP_TOOL_RULES), ...Object.keys(RAW_ROUTE_RULES)].filter((name) =>
        /ssh/iu.test(name),
      ),
    ).toEqual([]);
  });
});

describe("no door takes the Hub's cookies from a preview's own origin", () => {
  it("names, for every raw route and the HTTP API, how a preview origin's request is kept off", () => {
    const doors = [...new Set(rawRoutes), "HttpApi"];
    expect({
      undeclared: doors.filter((door) => !Object.hasOwn(AMBIENT_COOKIE_RULES, door)).toSorted(),
      stale: Object.keys(AMBIENT_COOKIE_RULES)
        .filter((door) => !doors.includes(door))
        .toSorted(),
    }).toEqual({ undeclared: [], stale: [] });
  });

  it("reads every Hub cookie through readHubCookie, and sets none for a preview origin", () => {
    // A cookie is read off a request in one place (readHubCookie: none from a preview page, no
    // bare one a preview could plant); the preview route reads only its own preview cookies.
    const direct = files.flatMap(({ file, text }) =>
      Array.from(text.matchAll(/\.cookies\[([^\]]+)\]/g), (match) => `${file}: ${match[1]}`),
    );
    expect(direct.toSorted()).toEqual([
      "preview/PreviewOrigin.ts: `${HOST_PREFIX}${name}`",
      "preview/PreviewOrigin.ts: name",
      "preview/hubPreviewRoute.ts: PREVIEW_COOKIE_NAME",
      "preview/hubPreviewRoute.ts: PREVIEW_ORIGIN_COOKIE_NAME",
    ]);
    // Every module that sets or clears a Hub cookie asks whether the request is a preview's.
    for (const file of ["auth/http.ts", "guest/http.ts"]) {
      expect(files.find((entry) => entry.file === file)?.text, file).toMatch(/fromPreviewOrigin/);
    }
    const cookieDoors = Object.entries(AMBIENT_COOKIE_RULES).filter(([door]) =>
      ["guest/http.ts: ", "preview/hubPreviewRoute.ts: *"].some((prefix) =>
        door.startsWith(prefix),
      ),
    );
    expect(cookieDoors.filter(([, rule]) => !("refused" in rule)).map(([door]) => door)).toEqual(
      [],
    );
  });
});
