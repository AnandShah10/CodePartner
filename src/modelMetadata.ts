/**
 * Static model metadata for the model picker — context window size only.
 *
 * Deliberately does NOT include a cost/pricing tier: per-model pricing
 * changes over time and this sandbox has no network access to verify
 * current figures, the same reasoning as usageExtraction.ts's decision
 * to show real token counts rather than a dollar estimate. A context
 * window size is a comparatively stable architectural fact about a
 * given model release, not a number that moves week to week — but it's
 * still a static table that will go stale as new models ship. Matching
 * is pattern-based (not exact-string) so it degrades gracefully: an
 * unrecognized model just gets no badge rather than a guessed-wrong one.
 * Extend MODEL_PATTERNS as new model families are added.
 */

export interface ModelMetadata {
  /** Context window size, in tokens. */
  contextWindow: number;
  /** Model may stream a separate thinking/reasoning channel. */
  supportsReasoning?: boolean;
}

const MODEL_PATTERNS: Array<{ pattern: RegExp; metadata: ModelMetadata }> = [
  { pattern: /o3|o1-pro|o1(?!\w)/i, metadata: { contextWindow: 200000, supportsReasoning: true } },
  { pattern: /gpt-5/i, metadata: { contextWindow: 200000, supportsReasoning: true } },
  { pattern: /deepseek-r1|deepseek-reasoner/i, metadata: { contextWindow: 128000, supportsReasoning: true } },
  { pattern: /claude-3-7|claude-4|claude-opus-4|claude-sonnet-4/i, metadata: { contextWindow: 200000, supportsReasoning: true } },
  { pattern: /gemini-2\.5|gemini-2\.0-flash-thinking/i, metadata: { contextWindow: 1000000, supportsReasoning: true } },
  { pattern: /gpt-4o/i, metadata: { contextWindow: 128000 } },
  { pattern: /gpt-4-turbo/i, metadata: { contextWindow: 128000 } },
  { pattern: /gpt-4-32k/i, metadata: { contextWindow: 32768 } },
  { pattern: /gpt-4/i, metadata: { contextWindow: 8192 } },
  { pattern: /gpt-3\.5-turbo-16k/i, metadata: { contextWindow: 16385 } },
  { pattern: /gpt-3\.5/i, metadata: { contextWindow: 16385 } },
  { pattern: /claude-3-5-sonnet|claude-3\.5-sonnet/i, metadata: { contextWindow: 200000 } },
  { pattern: /claude-3-5-haiku|claude-3\.5-haiku/i, metadata: { contextWindow: 200000 } },
  { pattern: /claude-3-opus/i, metadata: { contextWindow: 200000 } },
  { pattern: /claude-3-sonnet/i, metadata: { contextWindow: 200000 } },
  { pattern: /claude-3-haiku/i, metadata: { contextWindow: 200000 } },
  { pattern: /gemini-1\.5-pro/i, metadata: { contextWindow: 2000000 } },
  { pattern: /gemini-1\.5-flash/i, metadata: { contextWindow: 1000000 } },
  { pattern: /llama-?3\.1/i, metadata: { contextWindow: 128000 } },
  { pattern: /llama-?3/i, metadata: { contextWindow: 8192 } },
  { pattern: /mixtral/i, metadata: { contextWindow: 32000 } },
];

/** Returns known metadata for a model id via pattern match, or null if unrecognized. */
export function getModelMetadata(modelId: string): ModelMetadata | null {
  if (!modelId) {return null;}
  for (const { pattern, metadata } of MODEL_PATTERNS) {
    if (pattern.test(modelId)) {return metadata;}
  }
  return null;
}

/** Formats a token count for compact display, e.g. "128k ctx" or "2M ctx". */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M ctx`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}k ctx`;
  }
  return `${tokens} ctx`;
}