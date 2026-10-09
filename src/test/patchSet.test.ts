import * as assert from "assert";
import { buildFilePatch, createPatchSet } from "../patchSet";

suite("patchSet", () => {
  test("buildFilePatch extracts regions", () => {
    const fp = buildFilePatch("a.ts", "a\nb\n", "a\nB\n");
    assert.ok(fp.regions.length >= 1);
    assert.strictEqual(fp.path, "a.ts");
  });

  test("createPatchSet id", () => {
    const ps = createPatchSet([buildFilePatch("x.ts", "1", "2")]);
    assert.ok(ps.id.startsWith("patch-"));
    assert.strictEqual(ps.files.length, 1);
  });
});
