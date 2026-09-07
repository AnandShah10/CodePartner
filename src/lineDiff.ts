/**
 * Line-level diff, hunk grouping, and selective-hunk reconstruction — the
 * engine behind per-hunk diff review (Phase 3.2), replacing whole-file
 * approve/reject for Architect Mode drafts.
 *
 * This is a small self-contained LCS-based diff rather than a wrapper
 * around the `diff` npm package the roadmap mentions: this sandbox has no
 * network access, so there was no way to install and verify the real
 * package's exact output shape before depending on it. A hand-rolled,
 * fully unit-tested implementation of the same well-understood algorithm
 * carries less risk than guessing at a third-party API I can't check —
 * and it means one fewer runtime dependency for users to install. Swap
 * in the `diff` package later if preferred; the Hunk/DiffLine shapes here
 * are intentionally simple to make that an easy substitution.
 */

export interface DiffLine {
  type: "add" | "remove" | "context";
  value: string;
}

export interface Hunk {
  id: string;
  /** Lines to display for this hunk, padded with up to `context` lines of unchanged context on each side. */
  lines: DiffLine[];
  /** 1-based line number in the original file where this hunk's displayed range begins. */
  oldStart: number;
  /** 1-based line number in the new file where this hunk's displayed range begins. */
  newStart: number;
  /** [startIdx, endIdxExclusive) into the flat diffLines() array — this hunk's actual change lines, unpadded. */
  coreRange: [number, number];
}

// LCS diff over an n x m table is O(n*m) cells; guard against pathologically
// large inputs rather than hang the extension host.
const MAX_LCS_CELLS = 4_000_000;

/** Computes a line-level diff between oldText and newText using an LCS-based algorithm. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.length > 0 ? oldText.split("\n") : [];
  const newLines = newText.length > 0 ? newText.split("\n") : [];
  const n = oldLines.length;
  const m = newLines.length;

  if (n * m > MAX_LCS_CELLS) {
    // Fall back to a flat replace rather than hang on a huge file.
    const result: DiffLine[] = [];
    for (const l of oldLines) {result.push({ type: "remove", value: l });}
    for (const l of newLines) {result.push({ type: "add", value: l });}
    return result;
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: "context", value: oldLines[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "remove", value: oldLines[i] });
      i++;
    } else {
      result.push({ type: "add", value: newLines[j] });
      j++;
    }
  }
  while (i < n) { result.push({ type: "remove", value: oldLines[i] }); i++; }
  while (j < m) { result.push({ type: "add", value: newLines[j] }); j++; }

  return result;
}

/**
 * Groups a flat diff-line list into hunks: contiguous runs of add/remove
 * lines, padded with up to `context` lines of unchanged context on each
 * side. Change-runs within 2*context of each other are merged into one
 * hunk, since their padding would otherwise overlap.
 */
export function groupIntoHunks(lines: DiffLine[], context = 3): Hunk[] {
  const changeRanges: Array<[number, number]> = [];
  let curStart = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].type !== "context") {
      if (curStart === -1) {curStart = idx;}
    } else if (curStart !== -1) {
      changeRanges.push([curStart, idx]);
      curStart = -1;
    }
  }
  if (curStart !== -1) {changeRanges.push([curStart, lines.length]);}
  if (changeRanges.length === 0) {return [];}

  const merged: Array<[number, number]> = [];
  for (const [s, e] of changeRanges) {
    const last = merged[merged.length - 1];
    if (last && s - last[1] <= context * 2) {
      last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }

  const oldLineNo: number[] = [];
  const newLineNo: number[] = [];
  let oldCount = 0, newCount = 0;
  for (const l of lines) {
    oldLineNo.push(oldCount);
    newLineNo.push(newCount);
    if (l.type === "context") { oldCount++; newCount++; }
    else if (l.type === "remove") { oldCount++; }
    else { newCount++; }
  }

  return merged.map(([s, e], idx) => {
    const padStart = Math.max(0, s - context);
    const padEnd = Math.min(lines.length, e + context);
    return {
      id: `hunk-${idx}`,
      lines: lines.slice(padStart, padEnd),
      oldStart: oldLineNo[padStart] + 1,
      newStart: newLineNo[padStart] + 1,
      coreRange: [s, e] as [number, number],
    };
  });
}

/**
 * Reconstructs file content from the full diff-line list, applying only
 * the hunks whose id is in `acceptedHunkIds` and leaving the rest as the
 * original content. Context lines are always kept.
 */
export function applyAcceptedHunks(allLines: DiffLine[], hunks: Hunk[], acceptedHunkIds: Set<string>): string {
  const owner = new Array(allLines.length).fill(-1);
  hunks.forEach((h, hi) => {
    for (let i = h.coreRange[0]; i < h.coreRange[1]; i++) {owner[i] = hi;}
  });

  const output: string[] = [];
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (line.type === "context") {
      output.push(line.value);
      continue;
    }
    const hi = owner[i];
    const accepted = hi !== -1 && acceptedHunkIds.has(hunks[hi].id);
    if (line.type === "add") {
      if (accepted) {output.push(line.value);}
    } else if (line.type === "remove") {
      if (!accepted) {output.push(line.value);}
    }
  }
  return output.join("\n");
}