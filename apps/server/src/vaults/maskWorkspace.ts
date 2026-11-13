/**
 * Spec 5 ticket 05: a Thread's files as a client reads, searches and saves them. Reads come back
 * masked; a save puts each `[NAME]` the file held back to its value, so masking never writes a
 * placeholder over a secret (an editor saves what it was shown).
 */
import type { ProjectReadFileResult, ProjectSearchContentsResult } from "@t3tools/contracts";

import type * as SecretMasker from "./SecretMasker.ts";

/** A read, masked; a read cut short loses what is left of a value at its end. */
export const maskReadFile = (
  masker: SecretMasker.ThreadMasker,
  result: ProjectReadFileResult,
): ProjectReadFileResult => {
  if (masker.isEmpty) return result;
  const raw = result.truncated
    ? result.contents.slice(0, result.contents.length - masker.pendingSuffix(result.contents))
    : result.contents;
  const contents = masker.mask(raw);
  return contents === result.contents ? result : { ...result, contents };
};

/**
 * Search, without any match on a line that holds a value or ends in the start of one (a line is
 * cut at 512 characters): searching for parts of a value would otherwise spell it out. Once a match
 * is dropped, `truncated` no longer tells that more matched.
 */
export const maskSearchContents = (
  masker: SecretMasker.ThreadMasker,
  result: ProjectSearchContentsResult,
): ProjectSearchContentsResult => {
  if (masker.isEmpty) return result;
  const matches = result.matches.filter(
    (match) => !masker.matches(match.lineContent) && masker.pendingSuffix(match.lineContent) === 0,
  );
  return matches.length === result.matches.length
    ? result
    : { ...result, matches, truncated: false };
};

/**
 * What a save writes: each `[NAME]` of the Thread's set becomes the value the file holds under that
 * name (the file was read masked). A name the file does not hold stays as typed. Undefined (refuse)
 * when the file holds two values under one name (a rotation), or could not be read whole.
 */
export const restorePlaceholders = (
  masker: SecretMasker.ThreadMasker,
  current: string | undefined,
  contents: string,
): string | undefined => {
  if (masker.isEmpty || !contents.includes("[")) return contents;
  const placeholders = [...contents.matchAll(/\[([A-Z_][A-Z0-9_]*)\]/g)].filter((match) =>
    masker.names.has(match[1]!),
  );
  if (placeholders.length === 0) return contents;
  // The file could not be read whole: where its values are is unknown.
  if (current === undefined) return undefined;
  const held = new Map<string, Set<string>>();
  for (const interval of masker.intervals(current)) {
    const values = held.get(interval.name) ?? new Set<string>();
    values.add(current.slice(interval.start, interval.end));
    held.set(interval.name, values);
  }
  if (held.size === 0) return contents;
  let ambiguous = false;
  const restored = contents.replace(/\[([A-Z_][A-Z0-9_]*)\]/g, (placeholder, name: string) => {
    const values = held.get(name);
    if (values === undefined) return placeholder;
    if (values.size > 1) {
      ambiguous = true;
      return placeholder;
    }
    return [...values][0]!;
  });
  return ambiguous ? undefined : restored;
};
