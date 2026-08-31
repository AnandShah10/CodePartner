import * as assert from "assert";
import { extractUsageFromStreamEvent, formatTokenCount } from "../usageExtraction";

suite("extractUsageFromStreamEvent", () => {
  test("Anthropic message_start extracts both input and output tokens", () => {
    const event = { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 245, output_tokens: 1 } } };
    assert.deepStrictEqual(extractUsageFromStreamEvent("anthropic", event), { inputTokens: 245, outputTokens: 1 });
  });

  test("Anthropic message_delta extracts only output tokens", () => {
    const event = { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 87 } };
    assert.deepStrictEqual(extractUsageFromStreamEvent("anthropic", event), { outputTokens: 87 });
  });

  test("Anthropic content_block_delta has no usage data", () => {
    assert.strictEqual(extractUsageFromStreamEvent("anthropic", { type: "content_block_delta", delta: { text: "hi" } }), null);
  });

  test("OpenAI-family final usage chunk extracts both", () => {
    const event = { id: "x", choices: [], usage: { prompt_tokens: 512, completion_tokens: 128, total_tokens: 640 } };
    assert.deepStrictEqual(extractUsageFromStreamEvent("openai", event), { inputTokens: 512, outputTokens: 128 });
  });

  test("OpenAI-family regular delta chunk has no usage data", () => {
    assert.strictEqual(extractUsageFromStreamEvent("openai", { choices: [{ delta: { content: "hi" } }] }), null);
  });
});

suite("formatTokenCount", () => {
  test("formats a small count plainly", () => {
    assert.strictEqual(formatTokenCount(542), "542 tokens");
  });

  test("formats a large count with a k suffix", () => {
    assert.strictEqual(formatTokenCount(12345), "12.3k tokens");
  });

  test("formats the 1000 boundary correctly", () => {
    assert.strictEqual(formatTokenCount(1000), "1.0k tokens");
  });

  test("formats zero", () => {
    assert.strictEqual(formatTokenCount(0), "0 tokens");
  });
});