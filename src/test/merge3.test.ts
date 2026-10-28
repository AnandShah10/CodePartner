import * as assert from "assert";
import { merge3 } from "../merge3";
import { PatchTransaction } from "../patchSet";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

suite("merge3 + PatchTransaction", () => {
  test("clean take theirs when ours unchanged", () => {
    const r = merge3("a\nb\n", "a\nb\n", "a\nB\n");
    assert.strictEqual(r.conflicted, false);
    assert.ok(r.content.includes("B"));
  });

  test("conflict when both changed", () => {
    const r = merge3("a\nb\n", "a\nX\n", "a\nY\n");
    assert.strictEqual(r.conflicted, true);
    assert.ok(r.content.includes("<<<<<<<"));
  });

  test("transaction rollback restores files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-patch-"));
    const rel = "f.txt";
    const abs = path.join(dir, rel);
    fs.writeFileSync(abs, "pre", "utf8");
    const tx = new PatchTransaction(1);
    tx.record(rel, "pre", "post", false);
    fs.writeFileSync(abs, "post", "utf8");
    const { restored, errors } = tx.rollback((r) => path.join(dir, r));
    assert.strictEqual(errors.length, 0);
    assert.deepStrictEqual(restored, [rel]);
    assert.strictEqual(fs.readFileSync(abs, "utf8"), "pre");
  });
});
