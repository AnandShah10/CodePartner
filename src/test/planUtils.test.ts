import * as assert from "assert";
import { buildPlanFromTasks, validatePlanIndex } from "../planUtils";

suite("buildPlanFromTasks", () => {
  test("builds a plan from an array of plain strings", () => {
    const result = buildPlanFromTasks(["Read the config loader", "Add the new option", "Write a test"]);
    assert.ok("plan" in result);
    if ("plan" in result) {
      assert.deepStrictEqual(result.plan, [
        { task: "Read the config loader", done: false },
        { task: "Add the new option", done: false },
        { task: "Write a test", done: false },
      ]);
    }
  });

  test("trims whitespace and drops empty entries", () => {
    const result = buildPlanFromTasks(["  Do a thing  ", "", "   ", "Do another thing"]);
    assert.ok("plan" in result);
    if ("plan" in result) {
      assert.deepStrictEqual(result.plan.map((t) => t.task), ["Do a thing", "Do another thing"]);
    }
  });

  test("rejects a non-array input", () => {
    const result = buildPlanFromTasks("not an array");
    assert.ok("error" in result);
  });

  test("rejects an empty array", () => {
    const result = buildPlanFromTasks([]);
    assert.ok("error" in result);
  });

  test("rejects an array of only empty/whitespace strings", () => {
    const result = buildPlanFromTasks(["", "   "]);
    assert.ok("error" in result);
  });

  test("tolerates {task: string} objects in the array, not just plain strings", () => {
    const result = buildPlanFromTasks([{ task: "Step one" }, "Step two"]);
    assert.ok("plan" in result);
    if ("plan" in result) {
      assert.deepStrictEqual(result.plan.map((t) => t.task), ["Step one", "Step two"]);
    }
  });
});

suite("validatePlanIndex", () => {
  const plan = [
    { task: "a", done: false },
    { task: "b", done: false },
  ];

  test("accepts a valid in-bounds index", () => {
    assert.deepStrictEqual(validatePlanIndex(plan, 0), { ok: true });
    assert.deepStrictEqual(validatePlanIndex(plan, 1), { ok: true });
  });

  test("rejects a negative index", () => {
    const result = validatePlanIndex(plan, -1);
    assert.strictEqual(result.ok, false);
  });

  test("rejects an out-of-bounds index", () => {
    const result = validatePlanIndex(plan, 5);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /valid indices 0-1/);
    }
  });

  test("rejects a non-integer index", () => {
    const result = validatePlanIndex(plan, 1.5);
    assert.strictEqual(result.ok, false);
  });

  test("rejects a non-numeric index", () => {
    const result = validatePlanIndex(plan, "0" as any);
    assert.strictEqual(result.ok, false);
  });

  test("gives a sensible message for an empty plan", () => {
    const result = validatePlanIndex([], 0);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(!result.error.includes("valid indices"));
    }
  });
});