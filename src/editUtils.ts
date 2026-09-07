/**
 * Core search/replace matching logic used by editFile().
 *
 * Pulled out into a standalone, vscode-free module so it can be unit
 * tested directly (see src/test/editUtils.test.ts) and reused anywhere
 * else a search/replace edit needs to be applied safely.
 */

export type EditResult =
  | { ok: true; content: string; added: number; removed: number }
  | { ok: false; error: string };

/** Sentinel error string returned when the search text isn't present at all. */
export const NOT_FOUND = "NOT_FOUND";

/**
 * Applies a single search/replace edit to file content.
 *
 * Behavior:
 *  1. Tries an exact substring match. If the search text appears in more
 *     than one place, the edit is REFUSED — a silent first-occurrence edit
 *     is worse than an error, since it can quietly modify the wrong spot
 *     while reporting success.
 *  2. If there's no exact match, falls back to a whitespace-trimmed
 *     ("fuzzy") comparison, so incidental indentation differences between
 *     what the model sent and what's on disk don't block an otherwise
 *     unambiguous edit. The same ambiguity guard applies to the fuzzy path.
 *  3. If nothing matches either way, returns NOT_FOUND so the caller can
 *     tell the model to re-read the file and try again.
 */
export function applyEdit(originalContent: string, search: string, replace: string): EditResult {
  const exactMatches = countOccurrences(originalContent, search);

  let newContent: string;

  if (exactMatches > 1) {
    return {
      ok: false,
      error: `Ambiguous edit: the search text matches ${exactMatches} locations in the file. ` +
        `Add more surrounding context (e.g. a preceding or following line) so the match is unique, then try again.`,
    };
  }

  if (exactMatches === 1) {
    newContent = originalContent.replace(search, replace);
  } else {
    const searchTrimmed = search.split("\n").map((l) => l.trim()).join("\n");
    const contentLines = originalContent.split("\n");
    const contentTrimmed = contentLines.map((l) => l.trim()).join("\n");

    const fuzzyMatches = countOccurrences(contentTrimmed, searchTrimmed);
    if (fuzzyMatches > 1) {
      return {
        ok: false,
        error: `Ambiguous edit: the search text matches ${fuzzyMatches} locations in the file ` +
          `(after ignoring leading/trailing whitespace). Add more surrounding context so the match is unique, then try again.`,
      };
    }

    const idx = contentTrimmed.indexOf(searchTrimmed);
    if (idx === -1) {
      return { ok: false, error: NOT_FOUND };
    }

    const beforeTrimmed = contentTrimmed.substring(0, idx);
    const startLine = beforeTrimmed.split("\n").length - 1;
    const searchLineCount = searchTrimmed.split("\n").length;
    const beforeLines = contentLines.slice(0, startLine);
    const afterLines = contentLines.slice(startLine + searchLineCount);
    newContent = [...beforeLines, replace, ...afterLines].join("\n");
  }

  const oldLines = originalContent.split(/\r?\n/).filter((l) => l.trim() !== "");
  const newLines = newContent.split(/\r?\n/).filter((l) => l.trim() !== "");
  const removed = oldLines.filter((l) => !newLines.includes(l)).length;
  const added = newLines.filter((l) => !oldLines.includes(l)).length;

  return { ok: true, content: newContent, added, removed };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {return 0;}
  return haystack.split(needle).length - 1;
}