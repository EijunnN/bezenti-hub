// @effect-diagnostics nodeBuiltinImport:off - reads the server's own sources to list its paths.
/**
 * Spec 5 ticket 05, the inventory: every way a Thread's process output reaches the Hub is listed
 * in `MaskedPaths.ts`, and each one listed as masked really uses the masker. A new executor
 * operation, a new writer of the Thread tables or a history door reading a live stream fails here.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import { REMOTE_OPERATIONS, REMOTE_STREAM_ITEMS } from "../environment/RemoteExecutorWire.ts";
import {
  EXECUTOR_OPERATIONS,
  HISTORY_DOORS,
  type MaskedPath,
  ORCHESTRATION_TABLE_WRITERS,
  OTHER_PATHS,
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

/** What a file must contain to count as applying the masker. */
const MASKING =
  /SecretMasker|maskingEventWrites|maskTerminalStream|redactKnownSecrets|rememberKnownSecrets/;

const maskedFiles = (paths: Record<string, MaskedPath>) =>
  Object.entries(paths).flatMap(([name, path]) =>
    "masked" in path ? [{ name, file: path.masked }] : [],
  );

describe("MaskedPaths: every path of process output is masked or says why not", () => {
  it("lists every executor operation and stream", () => {
    const operations = [
      ...new Set([...Object.keys(REMOTE_OPERATIONS), ...Object.keys(REMOTE_STREAM_ITEMS)]),
    ].toSorted();
    expect(Object.keys(EXECUTOR_OPERATIONS).toSorted()).toEqual(operations);
  });

  it("names, for each masked path, a file that applies the masker", () => {
    for (const { name, file } of [
      ...maskedFiles(EXECUTOR_OPERATIONS),
      ...maskedFiles(OTHER_PATHS),
    ]) {
      const text = files.get(file);
      expect(text, `${name}: ${file} is missing`).toBeDefined();
      expect(MASKING.test(text ?? ""), `${name}: ${file} does not mask`).toBe(true);
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
      .toSorted();
    expect(writers).toEqual(Object.keys(ORCHESTRATION_TABLE_WRITERS).toSorted());
    for (const file of ["orchestration-v2/EventSink.ts", "orchestration-v2/ThreadMoveService.ts"]) {
      expect(MASKING.test(files.get(file) ?? ""), file).toBe(true);
    }
  });

  it("serves history only from the masked store, never from a live provider stream", () => {
    for (const door of HISTORY_DOORS) {
      const text = files.get(door);
      expect(text, door).toBeDefined();
      expect(text, door).not.toMatch(/runtime\.events|eventSubscribers|ProviderAdapterV2Event\b/);
    }
    // Live provider events are read on the Hub in one place, which hands them to the masked
    // sinks; a joined machine's agent reads its own sessions' to send them to the Hub.
    const readers = [...files]
      .filter(([, text]) => /\bruntime\.events\b/.test(text))
      .map(([file]) => file)
      .filter((file) => !file.startsWith("orchestration-v2/Adapters/"))
      .toSorted();
    expect(readers).toEqual([
      "environments/EnvironmentAgent.ts",
      "orchestration-v2/ProviderSessionManager.ts",
    ]);
  });

  it("wires the masker into the Hub", () => {
    expect(files.get("server.ts")).toMatch(/SecretMasker\.layer/);
    expect(files.get("vaults/SecretDelivery.ts")).toMatch(/\.remember\(/);
  });
});
