import * as assert from "assert";
import { addDiagnostic } from "../diagnostics";

suite("addDiagnostic", () => {
  test("adds an entry with the expected fields", () => {
    const list = addDiagnostic([], { severity: "warning", source: "Test", message: "first" }, 100, 1000);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].severity, "warning");
    assert.strictEqual(list[0].source, "Test");
    assert.strictEqual(list[0].message, "first");
    assert.strictEqual(list[0].timestamp, 1000);
    assert.ok(list[0].id);
  });

  test("prepends new entries (most recent first)", () => {
    let list = addDiagnostic([], { severity: "warning", source: "A", message: "first" }, 100, 1000);
    list = addDiagnostic(list, { severity: "error", source: "B", message: "second" }, 100, 2000);
    assert.strictEqual(list[0].message, "second");
    assert.strictEqual(list[1].message, "first");
    assert.notStrictEqual(list[0].id, list[1].id);
  });

  test("caps the list at maxEntries, keeping the most recent", () => {
    let list: ReturnType<typeof addDiagnostic> = [];
    for (let i = 0; i < 10; i++) {
      list = addDiagnostic(list, { severity: "warning", source: "X", message: `msg${i}` }, 5, 1000 + i);
    }
    assert.strictEqual(list.length, 5);
    assert.strictEqual(list[0].message, "msg9");
    assert.strictEqual(list[4].message, "msg5");
  });

  test("does not mutate the original array", () => {
    const original = addDiagnostic([], { severity: "warning", source: "a", message: "a" }, 100, 1);
    const updated = addDiagnostic(original, { severity: "error", source: "b", message: "b" }, 100, 2);
    assert.strictEqual(original.length, 1);
    assert.strictEqual(updated.length, 2);
  });
});