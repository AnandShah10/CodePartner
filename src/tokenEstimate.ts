/**
 * Approximate token estimation and token-budget-aware truncation.
 *
 * This sandbox has no network access, so there was no way to install and
 * verify a real tokenizer (tiktoken, gpt-tokenizer, or similar) against
 * its actual encoding tables before depending on it — same situation as
 * lineDiff.ts. What's here is a well-known, dependency-free approximation
 * (the "~4 characters per token" rule of thumb used widely as a rough
 * estimate for English prose and typical source code, combined with a
 * word-count-based estimate so token-dense content — lots of short
 * symbols/numbers — doesn't get badly undercounted). It is NOT an exact
 * token count for any specific model's tokenizer. Swap in a real
 * tokenizer's `encode(text).length` here later if you want exact counts;
 * the two functions below are the only integration points.
 */

/** Rough token-count estimate for `text`. Not exact — see module doc comment. */
export function estimateTokens(text: string): number {
  if (!text) {return 0;}
  const charEstimate = text.length / 4;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const wordEstimate = wordCount * 1.3;
  return Math.ceil(Math.max(charEstimate, wordEstimate));
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/**
 * Truncates `text` to fit within an approximate `maxTokens` budget.
 * Breaks on the nearest preceding line boundary when possible, so a
 * truncation lands at the end of a line rather than mid-word/mid-token —
 * the "silent mid-word truncation" the fixed character caps this
 * replaces were prone to.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): TruncateResult {
  if (maxTokens <= 0) {
    return { text: "", truncated: text.length > 0 };
  }
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) {
    return { text, truncated: false };
  }

  const approxCharsPerToken = text.length / estimated;
  let cutoff = Math.max(0, Math.min(text.length, Math.floor(maxTokens * approxCharsPerToken)));

  // The estimate isn't perfectly linear at small sizes (word-count term
  // can dominate) — nudge down until we're actually within budget.
  let guard = 0;
  while (cutoff > 0 && estimateTokens(text.slice(0, cutoff)) > maxTokens && guard < 50) {
    cutoff = Math.floor(cutoff * 0.9);
    guard++;
  }

  // Prefer breaking at a line boundary, as long as it doesn't throw away
  // more than half the already-computed budget.
  const lastNewline = text.lastIndexOf("\n", cutoff);
  if (lastNewline > cutoff * 0.5) {
    cutoff = lastNewline;
  }

  return { text: text.slice(0, cutoff), truncated: true };
}