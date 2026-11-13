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

/** The search engine (fff) cuts a line it shows at 512 bytes. */
const SEARCH_LINE_CAP_BYTES = 512;

type SearchMatch = ProjectSearchContentsResult["matches"][number];

/** Whether the hit is in, or runs into, the part of a line the result does not show. */
const hitPastTheCut = (match: SearchMatch): boolean => {
  // fff reports a hit past its cap with no ranges.
  if (match.matchRanges.length === 0) return true;
  // A cut line is at the cap; a multi-byte character can leave it a few bytes short.
  if (Buffer.byteLength(match.lineContent) < SEARCH_LINE_CAP_BYTES - 3) return false;
  return match.matchRanges.some((range) => range.end >= match.lineContent.length);
};

/**
 * Search, without any match on a line that holds a value or ends in the start of one, nor one whose
 * hit is past what the line shows (a line is cut at 512 bytes): searching for parts of a value would
 * otherwise spell it out, a character at a time. Once a match is dropped, `truncated` no longer
 * tells that more matched.
 */
export const maskSearchContents = (
  masker: SecretMasker.ThreadMasker,
  result: ProjectSearchContentsResult,
): ProjectSearchContentsResult => {
  if (masker.isEmpty) return result;
  const matches = result.matches.filter(
    (match) =>
      !hitPastTheCut(match) &&
      !masker.matches(match.lineContent) &&
      masker.pendingSuffix(match.lineContent) === 0,
  );
  return matches.length === result.matches.length
    ? result
    : { ...result, matches, truncated: false };
};

const PLACEHOLDER = /\[([A-Za-z_][A-Za-z0-9_]*)\]/g;

/** A `[NAME]` of the Thread's set in text, and what it stands for on disk. */
interface Slot {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  /** The value it masks, or the placeholder itself when the file holds that text as typed. */
  readonly original: string;
}

const slotsOf = (masker: SecretMasker.ThreadMasker, text: string, values: Map<number, string>) =>
  [...text.matchAll(PLACEHOLDER)].flatMap((match): Array<Slot> => {
    const name = match[1]!;
    if (!masker.names.has(name)) return [];
    return [
      {
        start: match.index,
        end: match.index + match[0].length,
        name,
        original: values.get(match.index) ?? match[0],
      },
    ];
  });

/**
 * What a save of masked text writes: a `[NAME]` where the file showed one goes back to what the
 * file holds there; one typed or copied elsewhere stays as typed. Place = the shared start and end,
 * then the n-th `[NAME]` between them. Undefined (refuse) when the file could not be read whole.
 */
export const restorePlaceholders = (
  masker: SecretMasker.ThreadMasker,
  current: string | undefined,
  contents: string,
): string | undefined => {
  if (masker.isEmpty || !contents.includes("[")) return contents;
  const saved = slotsOf(masker, contents, new Map());
  if (saved.length === 0) return contents;
  if (current === undefined) return undefined;
  // The file as it was shown, and the value behind each placeholder it showed.
  let shown = "";
  let cursor = 0;
  const values = new Map<number, string>();
  for (const interval of masker.intervals(current)) {
    shown += current.slice(cursor, interval.start);
    values.set(shown.length, current.slice(interval.start, interval.end));
    shown += `[${interval.name}]`;
    cursor = interval.end;
  }
  shown += current.slice(cursor);
  const before = slotsOf(masker, shown, values);
  if (before.every((slot) => slot.original === `[${slot.name}]`)) return contents;

  // The unchanged start and end of the text.
  const limit = Math.min(shown.length, contents.length);
  let prefix = 0;
  while (prefix < limit && shown.charCodeAt(prefix) === contents.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    shown.charCodeAt(shown.length - 1 - suffix) ===
      contents.charCodeAt(contents.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  const shift = shown.length - contents.length;
  const byStart = new Map(before.map((slot) => [slot.start, slot]));
  // Between them, the shown placeholders of each name, in order.
  const middle = new Map<string, Array<Slot>>();
  for (const slot of before) {
    if (slot.end <= prefix || slot.start >= shown.length - suffix) continue;
    const list = middle.get(slot.name) ?? [];
    list.push(slot);
    middle.set(slot.name, list);
  }
  const used = new Map<string, number>();
  let out = "";
  cursor = 0;
  for (const slot of saved) {
    let original: string;
    if (slot.end <= prefix) {
      original = byStart.get(slot.start)?.original ?? contents.slice(slot.start, slot.end);
    } else if (slot.start >= contents.length - suffix) {
      original = byStart.get(slot.start + shift)?.original ?? contents.slice(slot.start, slot.end);
    } else {
      const index = used.get(slot.name) ?? 0;
      used.set(slot.name, index + 1);
      original = middle.get(slot.name)?.[index]?.original ?? contents.slice(slot.start, slot.end);
    }
    out += contents.slice(cursor, slot.start) + original;
    cursor = slot.end;
  }
  return out + contents.slice(cursor);
};
