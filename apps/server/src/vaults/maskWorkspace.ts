/**
 * Spec 5 ticket 05: files a client reads and searches, masked with the asking User's own values.
 * A read that shows `[NAME]` says so (`masked`): the editor opens it read-only, and a save over a
 * file that holds a value is refused (saving what was shown would write `[NAME]` over it).
 */
import type { ProjectReadFileResult, ProjectSearchContentsResult } from "@t3tools/contracts";
import { maskWhole } from "@t3tools/shared/secretMasking";

import type * as SecretMasker from "./SecretMasker.ts";

/** Why a save is refused. */
export const FILE_HOLDS_SECRETS = "This file contains secrets; edit it in a terminal.";

/** A read, masked; one cut at its size limit shows a value starting at the cut as `[NAME]`. */
export const maskReadFile = (
  masker: SecretMasker.ThreadMasker,
  result: ProjectReadFileResult,
): ProjectReadFileResult => {
  if (masker.isEmpty) return result;
  const contents = result.truncated
    ? maskWhole(masker, result.contents)
    : masker.mask(result.contents);
  return contents === result.contents ? result : { ...result, contents, masked: true };
};

/** The search engine (fff) cuts a line it shows at 512 bytes. */
const SEARCH_LINE_CAP_BYTES = 512;
/** The most matches a search asks the engine for (the input's own limit). */
const SEARCH_MAX_LIMIT = 500;

/** How many matches to ask for, so dropping lines that hold a value still leaves `limit`. */
export const searchOverFetchLimit = (limit: number) => Math.min(SEARCH_MAX_LIMIT, limit * 4 + 20);

type SearchMatch = ProjectSearchContentsResult["matches"][number];

/** Whether the hit is in, or runs into, the part of a cut line the result does not show. */
const hitPastTheCut = (match: SearchMatch): boolean => {
  // fff reports a hit past its cap with no ranges.
  if (match.matchRanges.length === 0) return true;
  // A cut line is at the cap; a multi-byte character can leave it a few bytes short.
  if (Buffer.byteLength(match.lineContent) < SEARCH_LINE_CAP_BYTES - 3) return false;
  return match.matchRanges.some((range) => range.end >= match.lineContent.length);
};

/**
 * Search, filtered first and limited after (the engine was asked for more): no match on a line
 * that holds a value, nor one whose hit is past what a cut line shows. What the result says (its
 * matches, `truncated`) then depends only on the lines it may show, never on a value.
 */
export const maskSearchContents = (
  masker: SecretMasker.ThreadMasker,
  result: ProjectSearchContentsResult,
  limit: number,
): ProjectSearchContentsResult => {
  const kept = masker.isEmpty
    ? result.matches
    : result.matches.filter((match) => !hitPastTheCut(match) && !masker.matches(match.lineContent));
  return {
    ...result,
    matches: kept.slice(0, limit),
    truncated: result.truncated || kept.length > limit,
  };
};
