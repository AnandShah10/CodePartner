import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as cp from "child_process";
import { isGitRepo, createGitCheckpoint, restoreFileFromCheckpoint } from "../gitCheckpoint";

function git(args: string[], cwd: string): void {
  cp.execFileSync("git", args, { cwd, stdio: "ignore" });
}

suite("gitCheckpoint", () => {
  let repoDir: string;

  setup(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepartner-checkpoint-test-"));
    git(["init", "-q"], repoDir);
    git(["config", "user.email", "test@example.com"], repoDir);
    git(["config", "user.name", "Test"], repoDir);
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "original\n");
    git(["add", "tracked.txt"], repoDir);
    git(["commit", "-q", "-m", "initial"], repoDir);
  });

  teardown(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test("isGitRepo is true inside a repo and false outside one", () => {
    assert.strictEqual(isGitRepo(repoDir), true);
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "codepartner-not-a-repo-"));
    try {
      assert.strictEqual(isGitRepo(nonRepo), false);
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  test("createGitCheckpoint returns empty string on a clean tree", () => {
    const ref = createGitCheckpoint(repoDir, "test checkpoint");
    assert.strictEqual(ref, "");
  });

  test("restores a tracked file to its pre-turn content, even from a dirty checkpoint", () => {
    // Pre-turn: user already has an uncommitted edit before the "turn" starts.
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "user's manual edit\n");
    const ref = createGitCheckpoint(repoDir, "pre-turn checkpoint");
    assert.ok(ref, "expected a non-null checkpoint ref");
    assert.notStrictEqual(ref, "", "tree was dirty, so checkpoint should not be empty");

    // "Turn" happens: agent further modifies the file.
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "agent's edit on top\n");

    const ok = restoreFileFromCheckpoint(repoDir, ref!, "tracked.txt");
    assert.strictEqual(ok, true);
    const restored = fs.readFileSync(path.join(repoDir, "tracked.txt"), "utf8");
    assert.strictEqual(restored, "user's manual edit\n");
  });

  test("restores from HEAD when the checkpoint ref is empty (clean-tree case)", () => {
    const ref = createGitCheckpoint(repoDir, "clean checkpoint");
    assert.strictEqual(ref, "");

    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "agent's edit\n");
    const ok = restoreFileFromCheckpoint(repoDir, ref!, "tracked.txt");
    assert.strictEqual(ok, true);
    const restored = fs.readFileSync(path.join(repoDir, "tracked.txt"), "utf8");
    assert.strictEqual(restored, "original\n");
  });

  test("restoreFileFromCheckpoint fails gracefully for a path that didn't exist at the checkpoint", () => {
    const ref = createGitCheckpoint(repoDir, "checkpoint before new file");
    const ok = restoreFileFromCheckpoint(repoDir, ref || "", "never-existed.txt");
    assert.strictEqual(ok, false);
  });
});