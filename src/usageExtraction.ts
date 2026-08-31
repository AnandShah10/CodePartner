/**
 * Extracts token usage from a parsed streamed SSE event, for the status
 * bar token counter (Phase 4.1).
 *
 * Deliberately shows real token counts, not a dollar-cost estimate: this
 * sandbox has no network access to verify current per-model pricing, and
 * a stale or wrong price shown as a dollar figure is worse than none —
 * it looks authoritative while being wrong. Token counts come straight
 * from each provider's own usage field, so they're exact, not estimated
 * (unlike tokenEstimate.ts, which exists for content that never gets a
 * real API response, like the context budget).
 *
 * Usage often arrives split across multiple events within one response
 * (Anthropic splits input/output across message_start/message_delta), so
 * this returns a partial update per event — callers merge across calls
 * for one turn, e.g.:
 *   let input, output;
 *   const u = extractUsageFromStreamEvent(providerType, parsed);
 *   if (u?.inputTokens !== undefined) input = u.inputTokens;
 *   if (u?.outputTokens !== undefined) output = u.outputTokens;
 */

export interface PartialTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export function extractUsageFromStreamEvent(providerType: string, parsed: any): PartialTokenUsage | null {
  if (providerType === "anthropic") {
    if (parsed?.type === "message_start" && parsed.message?.usage) {
      const u = parsed.message.usage;
      const result: PartialTokenUsage = {};
      if (typeof u.input_tokens === "number") result.inputTokens = u.input_tokens;
      if (typeof u.output_tokens === "number") result.outputTokens = u.output_tokens;
      return Object.keys(result).length > 0 ? result : null;
    }
    if (parsed?.type === "message_delta" && parsed.usage && typeof parsed.usage.output_tokens === "number") {
      return { outputTokens: parsed.usage.output_tokens };
    }
    return null;
  }

  // OpenAI-family: usage appears in a final chunk, only when the request
  // set stream_options.include_usage (see aiProviderAdapter.ts).
  if (parsed?.usage) {
    const result: PartialTokenUsage = {};
    if (typeof parsed.usage.prompt_tokens === "number") result.inputTokens = parsed.usage.prompt_tokens;
    if (typeof parsed.usage.completion_tokens === "number") result.outputTokens = parsed.usage.completion_tokens;
    return Object.keys(result).length > 0 ? result : null;
  }
  return null;
}

/** Formats a session's cumulative token counts for the status bar, e.g. "12.3k tokens". */
export function formatTokenCount(total: number): string {
  if (total < 1000) return `${total} tokens`;
  return `${(total / 1000).toFixed(1)}k tokens`;
}