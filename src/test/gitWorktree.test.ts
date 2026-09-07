import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as cp from "child_process";
import { createWorktree, removeWorktree, getBranchDiffStat, commitAllIfDirty, toBranchSafeSegment } from "../gitWorktree";

function git(args: string[], cwd: string): string {
  return cp.execFileSync("git", args, { cwd, encoding: "utf8" });
}

suite("gitWorktree", () => {
  let repoDir: string;
  let baseBranch: string;

  setup(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepartner-wt-repo-"));
    git(["init", "-q"], repoDir);
    git(["config", "user.email", "test@example.com"], repoDir);
    git(["config", "user.name", "Test"], repoDir);
    fs.writeFileSync(path.join(repoDir, "app.js"), "console.log('v1');\n");
    git(["add", "-A"], repoDir);
    git(["commit", "-q", "-m", "initial"], repoDir);
    baseBranch = git(["branch", "--show-current"], repoDir).trim();
  });

  teardown(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test("createWorktree checks out a new branch into an isolated directory", () => {
    const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), "codepartner-wt-agent-")) + "-dir";
    const result = createWorktree(repoDir, wtPath, "codepartner/agent-test");
    assert.strictEqual(result.ok, true);
    assert.ok(fs.existsSync(path.join(wtPath, "app.js")));
    removeWorktree(repoDir, wtPath, true);
  });

  test("edits in a worktree never affect the main working tree", () => {
    const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), "codepartner-wt-agent-")) + "-dir";
    createWorktree(repoDir, wtPath, "codepartner/agent-isolation-test");
    fs.writeFileSync(path.join(wtPath, "app.js"), "console.log('agent version');\n");
    assert.strictEqual(fs.readFileSync(path.join(repoDir, "app.js"), "utf8"), "console.log('v1');\n");
    removeWorktree(repoDir, wtPath, true);
  });

  test("getBranchDiffStat reports files changed on the agent's branch", () => {
    const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), "codepartner-wt-agent-")) + "-dir";
    createWorktree(repoDir, wtPath, "codepartner/agent-diff-test");
    fs.writeFileSync(path.join(wtPath, "app.js"), "console.log('changed');\n");
    fs.writeFileSync(path.join(wtPath, "new.js"), "// new\n");
    git(["add", "-A"], wtPath);
    git(["commit", "-q", "-m", "agent change"], wtPath);

    const diff = getBranchDiffStat(repoDir, baseBranch, "codepartner/agent-diff-test");
    assert.strictEqual(diff.ok, true);
    if (diff.ok) {
      assert.ok(diff.summary.includes("app.js"));
      assert.ok(diff.summary.includes("new.js"));
    }
    removeWorktree(repoDir, wtPath, true);
  });

  test("removeWorktree cleans up the directory but keeps the branch", () => {
    const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), "codepartner-wt-agent-")) + "-dir";
    createWorktree(repoDir, wtPath, "codepartner/agent-cleanup-test");
    const result = removeWorktree(repoDir, wtPath, true);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(fs.existsSync(wtPath), false);
    const branches = git(["branch", "--list"], repoDir);
    assert.ok(branches.includes("agent-cleanup-test"));
  });

  test("createWorktree fails gracefully against a non-repo path", () => {
    const result = createWorktree("/nonexistent/path/xyz", "/tmp/wherever", "foo");
    assert.strictEqual(result.ok, false);
  });

  test("commitAllIfDirty is a no-op on a clean worktree", () => {
    const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), "codepartner-wt-agent-")) + "-dir";
    createWorktree(repoDir, wtPath, "codepartner/agent-clean-test");
    const result = commitAllIfDirty(wtPath, "auto commit");
    assert.strictEqual(result.ok, true);
    if (result.ok) {assert.strictEqual(result.committed, false);}
    removeWorktree(repoDir, wtPath, true);
  });

  test("commitAllIfDirty commits uncommitted changes, and the branch survives worktree removal (no data loss)", () => {
    const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), "codepartner-wt-agent-")) + "-dir";
    createWorktree(repoDir, wtPath, "codepartner/agent-safety-test");
    fs.writeFileSync(path.join(wtPath, "app.js"), "console.log('agent edit');\n");
    fs.writeFileSync(path.join(wtPath, "extra.js"), "// new\n");

    const commitResult = commitAllIfDirty(wtPath, "auto commit work");
    assert.strictEqual(commitResult.ok, true);
    if (commitResult.ok) {assert.strictEqual(commitResult.committed, true);}

    removeWorktree(repoDir, wtPath, true);

    // The whole point: even after the worktree directory is gone, the
    // committed work is still there on the branch.
    const preserved = git(["show", "codepartner/agent-safety-test:app.js"], repoDir);
    assert.strictEqual(preserved.trim(), "console.log('agent edit');");
    const preservedNew = git(["show", "codepartner/agent-safety-test:extra.js"], repoDir);
    assert.strictEqual(preservedNew.trim(), "// new");
  });
});

suite("toBranchSafeSegment", () => {
  test("sanitizes spaces and punctuation into hyphens", () => {
    assert.strictEqual(toBranchSafeSegment("Fix the login bug!!"), "fix-the-login-bug");
  });

  test("truncates long input", () => {
    assert.ok(toBranchSafeSegment("a".repeat(50)).length <= 30);
  });

  test("falls back to 'task' for empty input", () => {
    assert.strictEqual(toBranchSafeSegment(""), "task");
  });

  test("falls back to 'task' for all-punctuation input", () => {
    assert.strictEqual(toBranchSafeSegment("!!!???"), "task");
  });
});