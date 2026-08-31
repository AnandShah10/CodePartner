import * as assert from "assert";
import { isToolResultSuccess } from "../toolResultStatus";

suite("isToolResultSuccess", () => {
  test("a run_command success (exit code 0) is success", () => {
    assert.strictEqual(isToolResultSuccess("Exit code: 0\nsome output"), true);
  });

  test("a run_command failure (non-zero exit code) is NOT success — the bug this fixes", () => {
    assert.strictEqual(isToolResultSuccess("Exit code: 1\nsome error output"), false);
    assert.strictEqual(isToolResultSuccess("Exit code: 127\nbash: foo: command not found"), false);
  });

  test("a timed-out command is not success", () => {
    assert.strictEqual(isToolResultSuccess("Command timed out after 120s and was killed. Partial output:\n..."), false);
  });

  test("a run_command spawn error is not success", () => {
    assert.strictEqual(isToolResultSuccess("Error running command: spawn ENOENT"), false);
  });

  test("passing tests are success", () => {
    assert.strictEqual(isToolResultSuccess("Tests passed.\n\nsome output"), true);
  });

  test("failing tests are NOT success — the bug this fixes", () => {
    assert.strictEqual(isToolResultSuccess("Tests failed (exit code 1).\n\nSTDOUT..."), false);
  });

  test("timed-out tests are not success", () => {
    assert.strictEqual(isToolResultSuccess("Tests timed out after 300s and were killed. Partial output:\n..."), false);
  });

  test("an approval denial is not success", () => {
    assert.strictEqual(isToolResultSuccess("Denied: the user did not approve this shell action (run_command)."), false);
  });

  test("ordinary Error-prefixed failures are still caught (unchanged prior behavior)", () => {
    assert.strictEqual(isToolResultSuccess("Error: Could not find the search text in src/a.ts."), false);
  });

  test("ordinary successes are still success (unchanged prior behavior)", () => {
    assert.strictEqual(isToolResultSuccess("File src/a.ts updated successfully. +2 -1 lines."), true);
    assert.strictEqual(isToolResultSuccess("File src/new.ts created successfully."), true);
  });

  test("non-string results are treated as success (some tools return objects)", () => {
    assert.strictEqual(isToolResultSuccess({ id: "123" }), true);
    assert.strictEqual(isToolResultSuccess(undefined), true);
  });
});