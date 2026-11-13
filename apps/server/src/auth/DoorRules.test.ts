// @effect-diagnostics nodeBuiltinImport:off - reads the server's own sources to list its doors.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { EnvironmentHttpApi, WsRpcGroup } from "@t3tools/contracts";
import type * as SchemaAST from "effect/SchemaAST";
import { describe, expect, it } from "@effect/vitest";
import * as HttpApi from "effect/http-api/HttpApi";
import { Tool } from "effect/ai";

import { INSTALLATION_RPC_METHODS } from "@t3tools/contracts";

import {
  AI_ACCOUNT_SIGN_IN_RULES,
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

/** Every field name a schema can carry, at any depth and in any union member. */
const successFields = (
  ast: SchemaAST.AST,
  into: Set<string> = new Set(),
  seen: Set<SchemaAST.AST> = new Set(),
): Set<string> => {
  if (seen.has(ast)) return into;
  seen.add(ast);
  switch (ast._tag) {
    case "Objects":
      for (const property of ast.propertySignatures) {
        into.add(String(property.name));
        successFields(property.type, into, seen);
      }
      break;
    case "Arrays":
      for (const element of [...ast.elements, ...ast.rest]) successFields(element, into, seen);
      break;
    case "Union":
      for (const member of ast.types) successFields(member, into, seen);
      break;
    case "Suspend":
      successFields(ast.thunk(), into, seen);
      break;
  }
  return into;
};

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

  it("reads a Vault's value only through HTTP `vaults.reveal`: no WS, MCP or CLI door", () => {
    // The only callers of the reveal: the HTTP door, and the Vaults service that defines it.
    const callers = files
      .filter(({ text }) => /\.reveal\(|\.authorizeReveal\(/u.test(text))
      .map(({ file }) => file);
    expect(callers.toSorted()).toEqual(["vaults/http.ts"]);
    expect(Object.keys(HTTP_ENDPOINT_RULES).filter((name) => /reveal/iu.test(name))).toEqual([
      "vaults.reveal",
    ]);
    expect(
      [...Object.keys(MCP_TOOL_RULES), ...Object.keys(RAW_ROUTE_RULES)].filter((name) =>
        /vault|reveal/iu.test(name),
      ),
    ).toEqual([]);
    // No WS answer about Vaults has a field that could carry a value.
    const vaultRpcs = [...WsRpcGroup.requests.values()].filter((rpc) =>
      rpc._tag.startsWith("vaults."),
    );
    expect(vaultRpcs.length).toBe(14);
    for (const rpc of vaultRpcs) {
      expect(successFields(rpc.successSchema.ast), rpc._tag).not.toContain("value");
      // Spec 5 ticket 03: nor the id of one (EffectiveVaults' are for delivery alone).
      expect(successFields(rpc.successSchema.ast), rpc._tag).not.toContain("valueId");
    }
    // The effective set with value ids is for delivery (ticket 04) alone: the only door that
    // reaches it is the Thread's names, which strip them (EffectiveVaults.threadEnvironment). A
    // Project's move asks only which Vaults it loses, by name (ticket 07).
    const effectiveUsers = files
      .filter(({ text }) => /vaults\/EffectiveVaults\.ts"/u.test(text))
      .map(({ file }) => file);
    expect(effectiveUsers.toSorted()).toEqual(["project/ProjectService.ts", "server.ts", "ws.ts"]);
    for (const file of ["ws.ts", "project/ProjectService.ts"]) {
      const text = files.find((candidate) => candidate.file === file)?.text ?? "";
      expect(text, file).not.toMatch(/\.forThread\b/u);
    }
  });

  it("delivers secret values only where a process starts (spec 5 ticket 04)", () => {
    // SecretDelivery reads values: each module that reaches it starts a process of a Thread
    // (a provider session, a shell, a setup script), or asks only whether it has secrets.
    const deliveryUsers = files
      .filter(({ text }) => /vaults\/SecretDelivery\.ts"/u.test(text))
      .map(({ file }) => file);
    expect(deliveryUsers.toSorted()).toEqual([
      "environment/ThreadWorkspace.ts",
      "orchestration-v2/Orchestrator.ts",
      "orchestration-v2/ProviderSessionManager.ts",
      "project/ProjectSetupScriptRunner.ts",
      "server.ts",
    ]);
    const orchestrator = files.find(({ file }) => file === "orchestration-v2/Orchestrator.ts");
    expect(orchestrator?.text).not.toMatch(/\.(forProcess|forTurn)\(/u);
    // On the wire, values go only with the calls that start a process.
    const wire = files.find(({ file }) => file === "environment/RemoteExecutorWire.ts")?.text ?? "";
    expect(wire.match(/secretEnv: Schema\.optionalKey\(SecretEnv\)/gu)?.length).toBe(3);
  });

  it("keeps AI accounts' credentials in the Hub: only AiAccounts reads them, no answer carries one", () => {
    // The store's folder for them is read only by AiAccounts, which writes them into CLIProxyAPI.
    const readers = files
      .filter(({ text }) => /AiAccountCredentialStore\b/u.test(text))
      .map(({ file }) => file);
    expect(readers.toSorted()).toEqual(["ai/AiAccounts.ts", "auth/ServerSecretStore.ts"]);
    // No HTTP, raw route or MCP door for AI accounts: only the WS RPCs.
    expect(
      [
        ...Object.keys(HTTP_ENDPOINT_RULES),
        ...Object.keys(MCP_TOOL_RULES),
        ...Object.keys(RAW_ROUTE_RULES),
      ].filter((name) => /aiAccount|ai-account|ai_account/iu.test(name)),
    ).toEqual([]);
    // No WS answer about AI accounts has a field that could carry a credential.
    const accountRpcs = [...WsRpcGroup.requests.values()].filter((rpc) =>
      rpc._tag.startsWith("aiAccounts."),
    );
    expect(accountRpcs.map((rpc) => rpc._tag).toSorted()).toEqual([
      "aiAccounts.allow",
      "aiAccounts.create",
      "aiAccounts.delete",
      "aiAccounts.importVertex",
      "aiAccounts.list",
      "aiAccounts.login.complete",
      "aiAccounts.login.start",
      "aiAccounts.reorder",
      "aiAccounts.update",
    ]);
    for (const rpc of accountRpcs) {
      const fields = successFields(rpc.successSchema.ast);
      for (const credential of ["apiKey", "key", "credential", "secret", "token", "value"]) {
        expect(fields, rpc._tag).not.toContain(credential);
      }
    }
  });

  it("reaches CLIProxyAPI's API only through the gateway layer, with a gateway key and no cookie (spec 4 ticket 04)", () => {
    // The Hub's client key: written into its config, used by the management client and the
    // gateway layer, nothing else.
    const clientKeyUsers = files
      .filter(({ text }) => /\.clientKey\b/u.test(text))
      .map(({ file }) => file)
      .toSorted();
    expect(clientKeyUsers).toEqual([
      "ai/AiGatewayProxy.ts",
      "ai/CliproxyManagement.ts",
      "ai/cliproxyConfig.ts",
    ]);
    const gateway = Object.keys(RAW_ROUTE_RULES).filter((door) => door.startsWith("ai/"));
    expect(gateway).toEqual(["ai/AiGatewayRoute.ts: * `${AI_GATEWAY_ROUTE_PREFIX}/*`"]);
    expect(AMBIENT_COOKIE_RULES[gateway[0]!]).toHaveProperty("refused");
    // Keys are read and written by AiGatewayKeys alone (the migration aside): no other door.
    expect(
      files
        .filter(({ text }) => /\bai_gateway_keys\b/u.test(text))
        .map(({ file }) => file)
        .toSorted(),
    ).toEqual(["ai/AiGatewayKeys.ts", "persistence/Migrations/113_AiGatewayKeys.ts"]);
    // The route reads no cookie and no session: only its key headers.
    for (const file of ["ai/AiGatewayRoute.ts", "ai/AiGatewayProxy.ts"]) {
      const text = files.find((entry) => entry.file === file)?.text ?? "";
      expect(text, file).not.toMatch(/cookie|EnvironmentAuth|SessionStore|authenticateRequest/iu);
    }
  });

  it("hands a Thread's gateway key only to its provider process (spec 4 ticket 06)", () => {
    // Thread keys are issued in one place, for a provider session about to start a process.
    expect(
      files
        .filter(({ text }) => /\.issueForThread\(/u.test(text))
        .map(({ file }) => file)
        .toSorted(),
    ).toEqual(["ai/AiGatewaySessions.ts"]);
    // That rule is reached by the session manager (which opens the process), the orchestrator
    // (which only asks whether a Thread needs a process of its own) and the server's wiring.
    expect(
      files
        .filter(({ text }) => /ai\/AiGatewaySessions\.ts"/u.test(text))
        .map(({ file }) => file)
        .toSorted(),
    ).toEqual([
      "orchestration-v2/Orchestrator.ts",
      "orchestration-v2/ProviderSessionManager.ts",
      "server.ts",
    ]);
    const orchestrator = files.find(({ file }) => file === "orchestration-v2/Orchestrator.ts");
    expect(orchestrator?.text).not.toMatch(/\.forSession\(/u);
    // On the wire, the key goes only with `provider.openSession`.
    const wire = files.find(({ file }) => file === "environment/RemoteExecutorWire.ts")?.text ?? "";
    expect(wire.match(/aiGateway: Schema\.optionalKey\(AiGatewayAccess\)/gu)?.length).toBe(1);
    // Terminals and setup scripts never get one (a User's shell would carry the Thread's key).
    for (const file of [
      "environment/ThreadWorkspace.ts",
      "project/ProjectSetupScriptRunner.ts",
      "terminal/Manager.ts",
    ]) {
      const text = files.find((entry) => entry.file === file)?.text ?? "";
      expect(text, file).not.toMatch(/aiGateway|AiGatewaySessions|T3_AI_GATEWAY_KEY/u);
    }
    // A machine's agents reach the gateway through its one relay, which reads no credential.
    const relay = files.find(({ file }) => file === "environments/AiGatewayRelay.ts")?.text ?? "";
    expect(relay).toMatch(/listen\(0, "127\.0\.0\.1"/u);
    expect(relay).not.toMatch(/EnvironmentAuth|ServerSecretStore|joinedHubState|\.credential\b/u);
  });

  it("reads AI usage over one WS RPC only, counts only: no HTTP, raw route or MCP door, tables read by AiUsage alone (spec 4 ticket 05)", () => {
    const usageRpcs = [...WsRpcGroup.requests.values()].filter((rpc) =>
      /^aiUsage\./u.test(rpc._tag),
    );
    expect(usageRpcs.map((rpc) => rpc._tag)).toEqual(["aiUsage.summary"]);
    // Decided inside AiUsage.summary for the session (not the Owner's alone, so not `installation`).
    expect(typeof spaceAccessForRpcMethod("aiUsage.summary")).toBe("object");
    expect(
      [
        ...Object.keys(HTTP_ENDPOINT_RULES),
        ...Object.keys(MCP_TOOL_RULES),
        ...Object.keys(RAW_ROUTE_RULES),
        ...rawRoutes,
      ].filter((name) => /ai[-_ ]?usage/iu.test(name)),
    ).toEqual([]);
    // No answer has a field that could carry a prompt, an answer, a key or a header.
    const fields = successFields(usageRpcs[0]!.successSchema.ast);
    for (const content of ["prompt", "messages", "content", "text", "body", "key", "headers"]) {
      expect(fields).not.toContain(content);
    }
    // The tables: written and read by AiUsage alone (and created by their migration).
    const readers = files
      .filter(({ text }) => /\bai_usage(_daily)?\b/u.test(text))
      .map(({ file }) => file);
    expect(readers.toSorted()).toEqual(["ai/AiUsage.ts", "persistence/Migrations/114_AiUsage.ts"]);
  });

  it("signs in to subscriptions over the Owner's WS RPCs only: no callback route, tokens read by AiAccounts alone", () => {
    // Every sign-in door is the Owner's, on the Installation, whatever the session's scopes.
    const signIn = [...WsRpcGroup.requests.keys()].filter((tag) =>
      /^aiAccounts\.(login\.|importVertex)/u.test(tag),
    );
    expect(signIn.toSorted()).toEqual(Object.keys(AI_ACCOUNT_SIGN_IN_RULES).toSorted());
    for (const method of signIn) {
      expect([
        method,
        (INSTALLATION_RPC_METHODS as ReadonlyArray<string>).includes(method),
      ]).toEqual([method, true]);
      expect([method, spaceAccessForRpcMethod(method)]).toEqual([method, "installation"]);
    }
    // No door on the Hub takes a provider's redirect: no route or endpoint for a callback.
    expect(
      [...Object.keys(HTTP_ENDPOINT_RULES), ...Object.keys(RAW_ROUTE_RULES), ...rawRoutes].filter(
        (door) =>
          /callback|oauth-callback|auth-url/iu.test(door) && /ai|account|gateway/iu.test(door),
      ),
    ).toEqual([]);
    // The tokens' store folder is read by AiAccounts alone, which hands them to CLIProxyAPI.
    const readers = files
      .filter(({ text }) => /AiAccountTokenStore\b/u.test(text))
      .map(({ file }) => file);
    expect(readers.toSorted()).toEqual(["ai/AiAccounts.ts", "auth/ServerSecretStore.ts"]);
    // Only the Hub's management client talks to CLIProxyAPI's sign-in and credential API.
    // (The fake CLIProxyAPI of the tests, a testkit, answers them.)
    const management = files
      .filter(({ file }) => !file.endsWith(".testkit.ts"))
      .filter(({ text }) =>
        /\/oauth\/(auth-url|callback|status)|\/credentials\/download/u.test(text),
      )
      .map(({ file }) => file);
    expect(management.toSorted()).toEqual(["ai/CliproxyManagement.ts"]);
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
