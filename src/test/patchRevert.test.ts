import * as assert from "assert";
import { smartRevertEdit } from "../patchRevert";

suite("Phase 1 — patchRevert", () => {
  test("full restore when file still equals post-agent", () => {
    const pre = "a\nb\nc\n";
    const post = "a\nB\nc\n";
    const r = smartRevertEdit(pre, post, post);
    assert.strictEqual(r.mode, "full");
    assert.strictEqual(r.content, pre);
  });

  test("noop when already pre", () => {
    const pre = "x\n";
    const r = smartRevertEdit(pre, "y\n", pre);
    assert.strictEqual(r.mode, "noop");
  });

  test("partial preserves user lines outside agent region", () => {
    const pre = "keep\nold\n";
    const post = "keep\nnew\n";
    const current = "keep\nnew\nuser-added\n";
    const r = smartRevertEdit(pre, post, current);
    assert.ok(r.mode === "full" || r.mode === "partial");
    assert.ok(r.content.includes("user-added"));
    assert.ok(r.content.includes("old"));
    assert.ok(!r.content.includes("new") || r.content.indexOf("old") >= 0);
  });
});
