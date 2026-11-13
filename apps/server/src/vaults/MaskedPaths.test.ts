// @effect-diagnostics nodeBuiltinImport:off - reads the server's own sources to list its doors.
/**
 * Spec 5 ticket 05, the inventory: every door of the Hub (as DoorRules lists them) and every
 * executor operation has a masking rule in `MaskedPaths.ts`; a door marked masked names a test that
 * calls it with a secret and checks it comes back masked.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { EnvironmentHttpApi, WsRpcGroup } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as HttpApi from "effect/http-api/HttpApi";

import { MCP_TOOL_RULES, RAW_ROUTE_RULES } from "../auth/DoorRules.ts";
import { REMOTE_OPERATIONS, REMOTE_STREAM_ITEMS } from "../environment/RemoteExecutorWire.ts";
import {
  type DoorRule,
  EXECUTOR_OPERATIONS,
  HTTP_DOOR_RULES,
  MCP_DOOR_RULES,
  ORCHESTRATION_TABLE_WRITERS,
  RAW_DOOR_RULES,
  WS_DOOR_RULES,
} from "./MaskedPaths.ts";

const SRC = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const sources = (directory: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "testkit" ? [] : sources(full);
    return entry.name.endsWith(".ts") && !/\.test(kit)?\.ts$|\.testkit\.ts$/.test(entry.name)
      ? [full]
      : [];
  });

const files = new Map(
  sources(SRC).map((file) => [
    NodePath.relative(SRC, file).replaceAll("\\", "/"),
    NodeFS.readFileSync(file, "utf8"),
  ]),
);

const endpoints = (() => {
  const found: Array<string> = [];
  HttpApi.reflect(EnvironmentHttpApi, {
    onGroup: () => undefined,
    onEndpoint: ({ group, endpoint }) => found.push(`${group.identifier}.${endpoint.identifier}`),
  });
  return found;
})();

const DOORS = {
  ws: { doors: [...WsRpcGroup.requests.keys()], rules: WS_DOOR_RULES },
  http: { doors: endpoints, rules: HTTP_DOOR_RULES },
  raw: { doors: Object.keys(RAW_ROUTE_RULES), rules: RAW_DOOR_RULES },
  mcp: { doors: Object.keys(MCP_TOOL_RULES), rules: MCP_DOOR_RULES },
  executor: {
    doors: [...new Set([...Object.keys(REMOTE_OPERATIONS), ...Object.keys(REMOTE_STREAM_ITEMS)])],
    rules: EXECUTOR_OPERATIONS as Record<string, DoorRule>,
  },
};

/** The most specific rule for a door: its own name, else the longest `prefix*`. */
const ruleOf = (door: string, rules: Record<string, DoorRule>): string | undefined => {
  if (Object.hasOwn(rules, door)) return door;
  return Object.keys(rules)
    .filter((key) => key.endsWith("*") && door.startsWith(key.slice(0, -1)))
    .sort((a, b) => b.length - a.length)[0];
};

describe("MaskedPaths: every door says how a Thread's process output reaches it masked", () => {
  it("has a rule for every door, and no rule no door uses", () => {
    for (const [kind, { doors, rules }] of Object.entries(DOORS)) {
      expect(doors.length, kind).toBeGreaterThan(0);
      const used = new Set<string>();
      const without: Array<string> = [];
      for (const door of doors) {
        const rule = ruleOf(door, rules);
        if (rule === undefined) without.push(door);
        else used.add(rule);
      }
      expect({ kind, without }).toEqual({ kind, without: [] });
      expect({ kind, unused: Object.keys(rules).filter((rule) => !used.has(rule)) }).toEqual({
        kind,
        unused: [],
      });
    }
  });

  it("proves each masked door with a test that calls it, in code that masks", () => {
    const testTexts = new Map<string, string>();
    const testText = (file: string) => {
      const known = testTexts.get(file);
      if (known !== undefined) return known;
      const text = NodeFS.readFileSync(NodePath.join(SRC, file), "utf8");
      testTexts.set(file, text);
      return text;
    };
    for (const { rules } of Object.values(DOORS)) {
      for (const [door, rule] of Object.entries(rules)) {
        if (!("masked" in rule)) continue;
        const [file, title] = rule.proof.split(" > ");
        expect(file, door).toMatch(/\.test\.ts$/);
        expect(testText(file!), `${door}: ${rule.proof}`).toContain(`"${title}"`);
        expect(files.get(rule.masked), `${door}: ${rule.masked}`).toMatch(
          /SecretMasker|SecretStreamGuard|maskDeep/,
        );
      }
    }
  });

  it("knows every writer of the Thread tables", () => {
    const writers = [...files]
      .filter(
        ([file, text]) =>
          !file.startsWith("persistence/Migrations") &&
          /(INSERT INTO|UPDATE)\s+orchestration_v2_/.test(text),
      )
      .map(([file]) => file)
      .sort();
    expect(writers).toEqual(Object.keys(ORCHESTRATION_TABLE_WRITERS).sort());
  });

  it("serves history only from the masked store: live provider events are read in one place", () => {
    // On the Hub they go to the masked sinks; a joined machine's agent reads its own to send them.
    const readers = [...files]
      .filter(([, text]) => /\bruntime\.events\b/.test(text))
      .map(([file]) => file)
      .filter((file) => !file.startsWith("orchestration-v2/Adapters/"))
      .sort();
    expect(readers).toEqual([
      "environments/EnvironmentAgent.ts",
      "orchestration-v2/ProviderSessionManager.ts",
    ]);
  });

  it("wires the masker into the Hub and every delivery into it", () => {
    expect(files.get("server.ts")).toMatch(/SecretMasker\.layer/);
    expect(files.get("vaults/SecretDelivery.ts")).toMatch(/\.remember\(/);
    expect(files.get("orchestration-v2/EventSink.ts")).toMatch(/maskingEventWrites\(/);
    expect(files.get("git/GitManager.ts")).toMatch(/maskGitProgress\(/);
    expect(files.get("pullRequest/PullRequestService.ts")).toMatch(/maskingPullRequestReads\(/);
    expect(files.get("pullRequest/PullRequestReviewGuideService.ts")).toMatch(
      /maskingPullRequestReads\(/,
    );
    expect(files.get("review/ReviewService.ts")).toMatch(/maskingCheckoutReads\(/);
    expect(files.get("environment/ThreadWorkspace.ts")).toMatch(/restorePlaceholders\(/);
  });
});
