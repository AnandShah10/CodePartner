/**
 * Attempts to repair mildly malformed JSON coming from a streamed tool
 * call whose arguments got truncated or garbled in transit — e.g. the
 * stream cut off mid-string, or a trailing comma slipped in before a
 * closing bracket.
 *
 * This is deliberately narrow: it targets the specific failure modes seen
 * from LLM tool-call argument streams (unterminated string, unbalanced
 * braces/brackets, a trailing comma), not general "lenient JSON" parsing.
 * If none of that gets it to valid JSON, it gives up rather than guessing
 * further — a silently-wrong repaired value is worse than a clear error
 * asking the model to retry.
 */

export interface RepairResult {
  value: any;
  /** True if the input needed repair (i.e. wasn't already valid JSON). */
  repaired: boolean;
}

/** Returns the parsed value on success (repaired or not), or null if unrecoverable. */
export function repairJsonParse(raw: string): RepairResult | null {
  if (!raw || !raw.trim()) {return null;}

  try {
    return { value: JSON.parse(raw), repaired: false };
  } catch {
    // fall through to repair attempts
  }

  let candidate = raw.trim();

  // 1. Strip a trailing comma directly before a closing brace/bracket.
  candidate = candidate.replace(/,\s*([}\]])/g, "$1");
  try {
    return { value: JSON.parse(candidate), repaired: true };
  } catch {
    // continue
  }

  // 2. Looks cut off mid-stream — close any unterminated string, drop a
  //    now-trailing comma, then balance braces/brackets.
  candidate = closeUnterminatedString(candidate);
  candidate = candidate.replace(/,\s*$/, "");
  candidate = balanceBrackets(candidate);
  try {
    return { value: JSON.parse(candidate), repaired: true };
  } catch {
    return null;
  }
}

function closeUnterminatedString(s: string): string {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    }
  }
  return inString ? s + '"' : s;
}

function balanceBrackets(s: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) {escaped = false;}
      else if (ch === "\\") {escaped = true;}
      else if (ch === '"') {inString = false;}
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") {stack.push(ch);}
    else if (ch === "}") { if (stack[stack.length - 1] === "{") {stack.pop();} }
    else if (ch === "]") { if (stack[stack.length - 1] === "[") {stack.pop();} }
  }
  let result = s;
  while (stack.length) {
    const open = stack.pop();
    result += open === "{" ? "}" : "]";
  }
  return result;
}