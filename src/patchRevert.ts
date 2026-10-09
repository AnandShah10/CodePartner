/**
 * Phase 1 — patch-aware timeline revert.
 *
 * Full-file restore of pre-agent content is safe when the file is still
 * exactly what the agent wrote. If the user edited afterward, we try to
 * undo only agent change regions that are still present, preserving user
 * lines that do not match the agent result.
 */

import { diffLines } from "./lineDiff";

export type RevertMode = "full" | "partial" | "noop" | "skipped";

export interface SmartRevertResult {
  content: string;
  mode: RevertMode;
  /** Human-readable note for status bar / log */
  note: string;
}

interface Region {
  /** Text that was in the file before the agent edit */
  oldBlock: string;
  /** Text the agent wrote in its place */
  newBlock: string;
}

/** Extract contiguous replace regions from a pre→post line diff. */
function extractRegions(pre: string, post: string): Region[] {
  const lines = diffLines(pre, post);
  const regions: Region[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === "context") {
      i++;
      continue;
    }
    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (i < lines.length && lines[i].type !== "context") {
      if (lines[i].type === "remove") {
        oldLines.push(lines[i].value);
      } else if (lines[i].type === "add") {
        newLines.push(lines[i].value);
      }
      i++;
    }
    regions.push({
      oldBlock: oldLines.join("\n"),
      newBlock: newLines.join("\n"),
    });
  }
  return regions;
}

/**
 * Compute content after undoing an agent edit.
 * @param preAgent file content before the agent change
 * @param postAgent file content immediately after the agent change (optional)
 * @param current content on disk now
 */
export function smartRevertEdit(
  preAgent: string,
  postAgent: string | undefined,
  current: string
): SmartRevertResult {
  if (current === preAgent) {
    return { content: current, mode: "noop", note: "Already at pre-agent content" };
  }

  // Exact match to agent output → safe full restore
  if (postAgent !== undefined && current === postAgent) {
    return {
      content: preAgent,
      mode: "full",
      note: "Restored full pre-agent snapshot (file unchanged since agent)",
    };
  }

  // No post snapshot: only safe option is full restore (legacy timeline events)
  if (postAgent === undefined) {
    return {
      content: preAgent,
      mode: "full",
      note: "Restored pre-agent snapshot (no post-agent snapshot stored)",
    };
  }

  // User (or something) changed the file after the agent — undo regions still present
  const regions = extractRegions(preAgent, postAgent);
  if (regions.length === 0) {
    return { content: current, mode: "noop", note: "No agent regions to undo" };
  }

  let next = current;
  let applied = 0;
  let missed = 0;
  for (const r of regions) {
    if (!r.newBlock) {
      // Pure deletion by agent: only re-insert if old block is fully absent
      if (r.oldBlock && !next.includes(r.oldBlock)) {
        // Prefer prepending after a unique preceding context is unavailable — append once at end is too risky.
        // Leave as missed so we don't invent placement; full restore still works when current===post.
        missed++;
      }
      continue;
    }
    // Pure insertion by agent (no old lines): remove newBlock if still present
    if (!r.oldBlock && r.newBlock) {
      if (next.includes(r.newBlock)) {
        next = next.replace(r.newBlock, "");
        // tidy triple newlines
        next = next.replace(/\n{3,}/g, "\n\n");
        applied++;
      } else {
        missed++;
      }
      continue;
    }
    if (next.includes(r.newBlock)) {
      // Replace first occurrence of agent-new with agent-old
      next = next.replace(r.newBlock, r.oldBlock);
      applied++;
    } else {
      missed++;
    }
  }

  if (applied === 0) {
    return {
      content: current,
      mode: "skipped",
      note: "Could not safely undo agent regions (file diverged too far); left unchanged",
    };
  }

  return {
    content: next,
    mode: missed > 0 ? "partial" : "full",
    note:
      missed > 0
        ? `Partially reverted (${applied} region(s); ${missed} skipped to preserve later edits)`
        : `Reverted ${applied} agent region(s) while preserving later edits`,
  };
}
