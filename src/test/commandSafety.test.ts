import * as assert from "assert";
import { assessCommand } from "../commandSafety";

suite("commandSafety", () => {
  test("blocks rm -rf /", () => {
    const r = assessCommand("rm -rf /");
    assert.strictEqual(r.level, "block");
  });

  test("warns recursive force delete", () => {
    const r = assessCommand("rm -rf ./build");
    assert.strictEqual(r.level, "warn");
  });

  test("allows normal commands", () => {
    assert.strictEqual(assessCommand("npm test").level, "allow");
  });

  test("yolo still blocks root wipe", () => {
    assert.strictEqual(assessCommand("rm -rf /", true).level, "block");
  });
});
