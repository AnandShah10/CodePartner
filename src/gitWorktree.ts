import * as cp from "child_process";

/**
 * Git worktree management for running multiple sub-agents concurrently,
 * each fully isolated in its own branch and checked-out directory — so
 * they can edit the same files without conflicting with each other or
 * the user's actual working tree (Phase 5.5).
 *
 * `git worktree add <path> -b <branch>` creates a second, independent
 * working directory linked to the same repository but checked out to a
 * different branch. It's a real, first-class git feature (not a hack) —
 * verified directly against a real repo before relying on it here: two
 * worktrees editing the same file concurrently never conflict, each
 * commits independently on its own branch, and `git worktree remove`
 * cleans up without touching the main working tree or its branch.
 */

function runGit(args: string[], cwd: string): { ok: true; output: string } | { ok: false; error: string } {
  try {
    const output = cp.execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, error: (e.stderr || e.message || String(e)).toString().trim() };
  }
}

/** Creates a new worktree at `worktreePath`, checked out to a new branch `branchName` off the repo's current HEAD. */
export function createWorktree(repoRoot: string, worktreePath: string, branchName: string): { ok: true } | { ok: false; error: string } {
  const result = runGit(["worktree", "add", worktreePath, "-b", branchName], repoRoot);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Removes a worktree (does not delete its branch). `force` discards uncommitted changes in it. */
export function removeWorktree(repoRoot: string, worktreePath: string, force = true): { ok: true } | { ok: false; error: string } {
  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  const result = runGit(args, repoRoot);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Lists files changed on `branchName` relative to `baseBranch`, for a post-run summary. */
export function getBranchDiffStat(repoRoot: string, baseBranch: string, branchName: string): { ok: true; summary: string } | { ok: false; error: string } {
  const result = runGit(["diff", "--stat", `${baseBranch}...${branchName}`], repoRoot);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, summary: result.output.trim() || "(no changes)" };
}

/** Commits any uncommitted changes in a worktree, if there are any. Called before worktree removal so an agent's work is never silently discarded. */
export function commitAllIfDirty(worktreePath: string, message: string): { ok: true; committed: boolean } | { ok: false; error: string } {
  const status = runGit(["status", "--porcelain"], worktreePath);
  if (!status.ok) return { ok: false, error: status.error };
  if (status.output.trim() === "") {
    return { ok: true, committed: false };
  }
  const add = runGit(["add", "-A"], worktreePath);
  if (!add.ok) return { ok: false, error: add.error };
  const commit = runGit(["commit", "-q", "-m", message], worktreePath);
  if (!commit.ok) return { ok: false, error: commit.error };
  return { ok: true, committed: true };
}

/** Sanitizes free-form text into a safe git branch-name segment. */
export function toBranchSafeSegment(text: string, maxLen = 30): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || "task").slice(0, maxLen).replace(/-+$/, "");
}