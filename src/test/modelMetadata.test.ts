import * as assert from "assert";
import { getModelMetadata, formatContextWindow } from "../modelMetadata";

suite("getModelMetadata", () => {
  test("matches gpt-4o", () => {
    assert.strictEqual(getModelMetadata("gpt-4o")?.contextWindow, 128000);
  });

  test("matches gpt-4o-mini via the gpt-4o pattern", () => {
    assert.strictEqual(getModelMetadata("gpt-4o-mini")?.contextWindow, 128000);
  });

  test("matches gpt-4-turbo before the more general gpt-4 pattern", () => {
    assert.strictEqual(getModelMetadata("gpt-4-turbo-2024-04-09")?.contextWindow, 128000);
  });

  test("plain gpt-4 falls through to the 8k entry", () => {
    assert.strictEqual(getModelMetadata("gpt-4-0613")?.contextWindow, 8192);
  });

  test("matches claude-3-5-sonnet", () => {
    assert.strictEqual(getModelMetadata("claude-3-5-sonnet-20241022")?.contextWindow, 200000);
  });

  test("matches gemini-1.5-pro", () => {
    assert.strictEqual(getModelMetadata("gemini-1.5-pro")?.contextWindow, 2000000);
  });

  test("matches llama-3.1 before the more general llama-3 pattern", () => {
    assert.strictEqual(getModelMetadata("llama-3.1-70b")?.contextWindow, 128000);
  });

  test("plain llama3 falls through to the 8k entry", () => {
    assert.strictEqual(getModelMetadata("llama3")?.contextWindow, 8192);
  });

  test("returns null for an unrecognized model rather than guessing", () => {
    assert.strictEqual(getModelMetadata("some-brand-new-model-xyz"), null);
  });

  test("returns null for an empty string", () => {
    assert.strictEqual(getModelMetadata(""), null);
  });
});

suite("formatContextWindow", () => {
  test("formats thousands with a k suffix", () => {
    assert.strictEqual(formatContextWindow(128000), "128k ctx");
    assert.strictEqual(formatContextWindow(8192), "8k ctx");
  });

  test("formats millions with an M suffix", () => {
    assert.strictEqual(formatContextWindow(2000000), "2M ctx");
  });

  test("formats a non-round million with one decimal", () => {
    assert.strictEqual(formatContextWindow(1500000), "1.5M ctx");
  });

  test("formats small counts as a raw number", () => {
    assert.strictEqual(formatContextWindow(512), "512 ctx");
  });
});