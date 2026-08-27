import * as assert from "assert";
import { estimateTokens, truncateToTokenBudget } from "../tokenEstimate";

suite("estimateTokens", () => {
  test("empty string is zero tokens", () => {
    assert.strictEqual(estimateTokens(""), 0);
  });

  test("non-empty text has a positive estimate", () => {
    assert.ok(estimateTokens("hello world") > 0);
  });

  test("longer text has a proportionally larger estimate", () => {
    assert.ok(estimateTokens("a".repeat(4000)) > estimateTokens("a".repeat(400)));
  });
});

suite("truncateToTokenBudget", () => {
  test("text within budget is returned untouched", () => {
    const result = truncateToTokenBudget("short text", 1000);
    assert.strictEqual(result.text, "short text");
    assert.strictEqual(result.truncated, false);
  });

  test("text over budget gets cut down and flagged", () => {
    const longText = Array.from({ length: 200 }, (_, i) => `line number ${i}`).join("\n");
    const result = truncateToTokenBudget(longText, 50);
    assert.strictEqual(result.truncated, true);
    assert.ok(result.text.length < longText.length);
    assert.ok(estimateTokens(result.text) <= 55); // small slack for line-boundary snap
  });

  test("truncation breaks on complete line boundaries, never mid-line", () => {
    const longText = Array.from({ length: 200 }, (_, i) => `line number ${i}`).join("\n");
    const result = truncateToTokenBudget(longText, 50);
    const originalLines = longText.split("\n");
    const truncatedLines = result.text.split("\n");
    for (let i = 0; i < truncatedLines.length; i++) {
      assert.strictEqual(truncatedLines[i], originalLines[i], `line ${i} should be a complete original line, not a partial cut`);
    }
  });

  test("maxTokens of 0 on non-empty text returns empty and marks truncated", () => {
    const result = truncateToTokenBudget("some text", 0);
    assert.strictEqual(result.text, "");
    assert.strictEqual(result.truncated, true);
  });

  test("maxTokens of 0 on empty text is not marked truncated (nothing to truncate)", () => {
    const result = truncateToTokenBudget("", 0);
    assert.strictEqual(result.text, "");
    assert.strictEqual(result.truncated, false);
  });

  test("negative maxTokens returns empty text", () => {
    const result = truncateToTokenBudget("some text", -5);
    assert.strictEqual(result.text, "");
  });
});