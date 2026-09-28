import * as assert from "assert";
import { applyEdit, NOT_FOUND } from "../editUtils";

suite("applyEdit", () => {
  test("replaces a single unique exact match", () => {
    const result = applyEdit("const a = 1;\nconst b = 2;\n", "const a = 1;", "const a = 10;");
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.content, "const a = 10;\nconst b = 2;\n");
      assert.strictEqual(result.added, 1);
      assert.strictEqual(result.removed, 1);
    }
  });

  test("refuses an ambiguous exact match instead of editing the first occurrence", () => {
    const content = "return null;\nif (x) {\n  return null;\n}\n";
    const result = applyEdit(content, "return null;", "return undefined;");
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /2 locations/);
    }
  });

  test("reports NOT_FOUND when the search text is absent", () => {
    const result = applyEdit("const a = 1;\n", "const z = 99;", "const z = 100;");
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error, NOT_FOUND);
    }
  });

  test("falls back to whitespace-trimmed matching for a single fuzzy match", () => {
    // Search uses 2-space indent; file uses 4-space indent — no exact
    // substring match, but exactly one match once each line is trimmed.
    const content = "function foo() {\n    return 1;\n}\n";
    const search = "function foo() {\n  return 1;\n}";
    const result = applyEdit(content, search, "function foo() {\n  return 2;\n}");
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.ok(result.content.includes("return 2;"));
    }
  });

  test("refuses an ambiguous fuzzy match", () => {
    // Trailing space means there's no exact match, forcing the fuzzy path;
    // "foo();" (trimmed) appears twice in the file.
    const content = "foo();\nbar();\nfoo();\n";
    const result = applyEdit(content, "foo(); ", "baz();");
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /2 locations/);
    }
  });
});