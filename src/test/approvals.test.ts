import * as assert from "assert";
import { needsApprovalForPolicy, commandPrefix, matchesApprovedPrefix } from "../approvals";

suite("needsApprovalForPolicy", () => {
  test("always-ask gates every category", () => {
    assert.strictEqual(needsApprovalForPolicy("shell", "always-ask"), true);
    assert.strictEqual(needsApprovalForPolicy("file-write", "always-ask"), true);
    assert.strictEqual(needsApprovalForPolicy("git-write", "always-ask"), true);
  });

  test("ask-for-shell only gates shell", () => {
    assert.strictEqual(needsApprovalForPolicy("shell", "ask-for-shell"), true);
    assert.strictEqual(needsApprovalForPolicy("file-write", "ask-for-shell"), false);
    assert.strictEqual(needsApprovalForPolicy("git-write", "ask-for-shell"), false);
  });

  test("full-auto only gates git-write", () => {
    assert.strictEqual(needsApprovalForPolicy("shell", "full-auto"), false);
    assert.strictEqual(needsApprovalForPolicy("file-write", "full-auto"), false);
    assert.strictEqual(needsApprovalForPolicy("git-write", "full-auto"), true);
  });

  test("yolo gates nothing", () => {
    assert.strictEqual(needsApprovalForPolicy("shell", "yolo"), false);
    assert.strictEqual(needsApprovalForPolicy("file-write", "yolo"), false);
    assert.strictEqual(needsApprovalForPolicy("git-write", "yolo"), false);
  });
});

suite("commandPrefix / matchesApprovedPrefix", () => {
  test("extracts a two-word prefix", () => {
    assert.strictEqual(commandPrefix("git status --short"), "git status");
    assert.strictEqual(commandPrefix("npm test -- --watch"), "npm test");
  });

  test("extracts a one-word prefix for single-word commands", () => {
    assert.strictEqual(commandPrefix("ls"), "ls");
  });

  test("matches an approved prefix at a word boundary", () => {
    const approved = new Set(["git status"]);
    assert.strictEqual(matchesApprovedPrefix("git status --short", approved), true);
    assert.strictEqual(matchesApprovedPrefix("git status", approved), true);
  });

  test("does not match a different command sharing a prefix substring", () => {
    const approved = new Set(["git status"]);
    // "git statusx" is not the same command as "git status" despite the substring match
    assert.strictEqual(matchesApprovedPrefix("git statusx", approved), false);
  });

  test("does not let an approved read-only prefix cover a destructive command", () => {
    const approved = new Set(["git status"]);
    assert.strictEqual(matchesApprovedPrefix("git push --force", approved), false);
  });
});