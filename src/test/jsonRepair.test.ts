import * as assert from "assert";
import { repairJsonParse } from "../jsonRepair";

suite("repairJsonParse", () => {
  test("parses valid JSON without flagging a repair", () => {
    const result = repairJsonParse('{"path":"a.ts","content":"hello"}');
    assert.ok(result);
    assert.strictEqual(result!.repaired, false);
    assert.deepStrictEqual(result!.value, { path: "a.ts", content: "hello" });
  });

  test("repairs a trailing comma before a closing brace", () => {
    const result = repairJsonParse('{"path":"a.ts","content":"hello",}');
    assert.ok(result);
    assert.strictEqual(result!.repaired, true);
    assert.deepStrictEqual(result!.value, { path: "a.ts", content: "hello" });
  });

  test("repairs an unterminated string from a truncated stream", () => {
    const result = repairJsonParse('{"path":"a.ts","content":"hello world');
    assert.ok(result);
    assert.strictEqual(result!.repaired, true);
    assert.deepStrictEqual(result!.value, { path: "a.ts", content: "hello world" });
  });

  test("repairs an unclosed object", () => {
    const result = repairJsonParse('{"path":"a.ts","content":"hello"');
    assert.ok(result);
    assert.strictEqual(result!.repaired, true);
    assert.deepStrictEqual(result!.value, { path: "a.ts", content: "hello" });
  });

  test("repairs a truncated nested structure", () => {
    const result = repairJsonParse('{"args":{"a":1,"b":[1,2,3');
    assert.ok(result);
    assert.strictEqual(result!.repaired, true);
    assert.deepStrictEqual(result!.value, { args: { a: 1, b: [1, 2, 3] } });
  });

  test("returns null for empty input", () => {
    assert.strictEqual(repairJsonParse(""), null);
    assert.strictEqual(repairJsonParse("   "), null);
  });

  test("returns null when the content is not JSON-shaped at all", () => {
    assert.strictEqual(repairJsonParse("this is not json in any way{[}"), null);
  });
});