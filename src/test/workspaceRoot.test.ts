import * as assert from "assert";
import * as path from "path";
// workspaceRoot depends on vscode API; unit-test pure path logic via require of helpers when possible.
// Smoke: module loads and exports exist.
import { formatWorkspaceRoots, getPreferredWorkspaceRoot } from "../workspaceRoot";

suite("Multi-root — workspaceRoot", () => {
  test("exports are functions", () => {
    assert.strictEqual(typeof getPreferredWorkspaceRoot, "function");
    assert.strictEqual(typeof formatWorkspaceRoots, "function");
  });
});
