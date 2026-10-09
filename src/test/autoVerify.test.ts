import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findRelatedTestFiles, planAutoVerify, detectRunner } from "../autoVerify";

suite("autoVerify", () => {
  test("finds related vitest file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-av-"));
    fs.writeFileSync(path.join(dir, "foo.ts"), "export const x = 1;");
    fs.writeFileSync(path.join(dir, "foo.test.ts"), "test('x', () => {});");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^1.0.0" } })
    );
    const tests = findRelatedTestFiles(dir, ["foo.ts"]);
    assert.ok(tests.some((t) => t.includes("foo.test")));
    const plan = planAutoVerify(dir, ["foo.ts"], "focused");
    assert.ok(plan);
    assert.ok(plan!.command.includes("vitest"));
    assert.ok(plan!.command.includes("foo.test"));
  });

  test("detectRunner npm fallback", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-av2-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node test.js" } })
    );
    const r = detectRunner(dir);
    assert.strictEqual(r.runner, "npm");
  });
});
