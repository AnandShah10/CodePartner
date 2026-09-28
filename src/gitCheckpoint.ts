import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Git-backed checkpoint fallback, used alongside (not instead of) the
 * existing in-memory/persisted revertContent backups in extension.ts.
 *
 * `git stash create` builds an unreferenced commit object representing
 * the current tracked-file state — without touching the working tree or
 * the stash ref list — and hands back its SHA. That SHA can later be used
 * with `git checkout <sha> -- <path>` to restore an individual file's
 * content, even if the state at checkpoint time was itself uncommitted.
 *
 * Limitations (by design — this is a fallback, not a full replacement):
 *  - Only covers tracked files. A file created fresh during a turn has no
 *    prior git content to fall back to; the app-level "was created by
 *    this turn, so revert = delete" bookkeeping still handles that case.
 *  - Checkpoint commits are unreferenced, so they're eligible for git gc
 *    after its default grace period (~2 weeks) — fine for "revert this
 *    turn" within a session, not a long-term backup.
 */

function runGit(args: string[], cwd: string): string | null {
  try {
    return cp.execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** True if `cwd` is inside a git working tree. */
export function isGitRepo(cwd: string): boolean {
  const out = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return out !== null && out.trim() === "true";
}

/**
 * Captures current tracked-file state as an unreferenced commit.
 * Returns the SHA, "" if the working tree is clean (nothing to capture —
 * treat "" as "restore from HEAD"), or null if git isn't usable here.
 */
export function createGitCheckpoint(cwd: string, message = "codepartner checkpoint"): string | null {
  return runGit(["stash", "create", message], cwd)?.trim() ?? null;
}

/** Restores one tracked file's content from a checkpoint ref ("" means HEAD). Returns success.
 *  Uses `git show <ref>:<path>` (write content directly) rather than
 *  `git checkout <ref> -- <path>` — checkout also stages the file in the
 *  index, which leaves stray staged state behind and makes a *later*
 *  checkpoint on the same path look "dirty" even once the working tree
 *  content matches HEAD again. `git show` only touches the working tree.
 */
export function restoreFileFromCheckpoint(cwd: string, ref: string, relPath: string): boolean {
  const target = ref || "HEAD";
  const content = runGit(["show", `${target}:${relPath}`], cwd);
  if (content === null) {
    return false;
  }
  try {
    fs.writeFileSync(path.join(cwd, relPath), content);
    return true;
  } catch {
    return false;
  }
}