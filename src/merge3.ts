/**
 * Simple 3-way line merge (base / ours / theirs).
 * Emits conflict markers when both sides changed the same region.
 */

export interface Merge3Result {
  content: string;
  conflicted: boolean;
  conflictCount: number;
}

type Side = "base" | "ours" | "theirs";

/**
 * Myers-style is overkill; we use a stable split:
 * - equal prefix/suffix with base
 * - middle chunks compared pairwise
 *
 * Algorithm:
 * 1. Diff base→ours and base→theirs as line arrays
 * 2. Walk aligned blocks; clean merges auto-apply; overlaps → conflict markers
 */
export function merge3(base: string, ours: string, theirs: string): Merge3Result {
  if (ours === theirs) {
    return { content: ours, conflicted: false, conflictCount: 0 };
  }
  if (ours === base) {
    return { content: theirs, conflicted: false, conflictCount: 0 };
  }
  if (theirs === base) {
    return { content: ours, conflicted: false, conflictCount: 0 };
  }

  const b = splitLines(base);
  const o = splitLines(ours);
  const t = splitLines(theirs);

  // LCS-free chunk approach: hash line windows from base and map
  // For practicality: region-based merge using longest common prefix/suffix
  // then recurse on middles once; if still diverged, emit conflict.
  const result = mergeArrays(b, o, t);
  const content = result.lines.join("\n");
  return {
    content,
    conflicted: result.conflicts > 0,
    conflictCount: result.conflicts,
  };
}

function splitLines(s: string): string[] {
  if (s === "") {
    return [];
  }
  return s.split("\n");
}

function mergeArrays(
  base: string[],
  ours: string[],
  theirs: string[]
): { lines: string[]; conflicts: number } {
  // Find common prefix
  let lo = 0;
  while (
    lo < base.length &&
    lo < ours.length &&
    lo < theirs.length &&
    base[lo] === ours[lo] &&
    base[lo] === theirs[lo]
  ) {
    lo++;
  }

  // Common suffix
  let bo = base.length - 1;
  let oo = ours.length - 1;
  let to = theirs.length - 1;
  while (
    bo >= lo &&
    oo >= lo &&
    to >= lo &&
    base[bo] === ours[oo] &&
    base[bo] === theirs[to]
  ) {
    bo--;
    oo--;
    to--;
  }

  const prefix = base.slice(0, lo);
  const suffix = base.slice(bo + 1);

  const bMid = base.slice(lo, bo + 1);
  const oMid = ours.slice(lo, oo + 1);
  const tMid = theirs.slice(lo, to + 1);

  // Clean cases for middle
  if (arraysEqual(oMid, tMid)) {
    return { lines: [...prefix, ...oMid, ...suffix], conflicts: 0 };
  }
  if (arraysEqual(oMid, bMid)) {
    return { lines: [...prefix, ...tMid, ...suffix], conflicts: 0 };
  }
  if (arraysEqual(tMid, bMid)) {
    return { lines: [...prefix, ...oMid, ...suffix], conflicts: 0 };
  }

  // One side equal to empty and other not — still conflict if both non-base
  const conflictBlock = [
    "<<<<<<< Ours (current)",
    ...oMid,
    "=======",
    ...tMid,
    ">>>>>>> Theirs (agent)",
  ];
  return {
    lines: [...prefix, ...conflictBlock, ...suffix],
    conflicts: 1,
  };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Apply agent side only (discard ours for conflicted regions) — naive: prefer theirs. */
export function takeTheirs(base: string, ours: string, theirs: string): string {
  return theirs;
}

/** Prefer ours. */
export function takeOurs(base: string, ours: string, theirs: string): string {
  return ours;
}
