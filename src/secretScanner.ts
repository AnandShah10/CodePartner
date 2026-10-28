/**
 * Lightweight, dependency-free scanner that flags content which looks like
 * a credential before it gets pasted into a prompt sent to a third-party
 * LLM API (or, in the feedback-report path, into a public GitHub issue).
 *
 * Phase 0 roadmap: callers should prefer `redactSecretsInText` for model
 * context (warn + replace matches) rather than warn-only. False positives
 * are possible; redaction prefers safety over perfect fidelity.
 */

export interface SecretFinding {
  /** Short human-readable label, e.g. "AWS access key". */
  label: string;
  /** A short, still-partially-redacted preview of the match. */
  preview: string;
}

interface Pattern {
  label: string;
  regex: RegExp;
}

// Order matters only for readability; every pattern is checked independently.
const PATTERNS: Pattern[] = [
  { label: "AWS access key", regex: /AKIA[0-9A-Z]{16}/g },
  { label: "AWS secret key (heuristic)", regex: /aws(.{0,20})?(secret|access)[_-]?key(.{0,20})?['"][0-9a-zA-Z/+]{40}['"]/gi },
  { label: "OpenAI-style API key", regex: /sk-[A-Za-z0-9]{20,}/g },
  { label: "Anthropic API key", regex: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  { label: "Google API key", regex: /AIza[0-9A-Za-z\-_]{35}/g },
  { label: "GitHub token", regex: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { label: "Slack token", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { label: "Private key header", regex: /-----BEGIN(?: RSA| EC| OPENSSH| DSA| PGP)? PRIVATE KEY-----/g },
  { label: "JWT", regex: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  // .env-shaped lines: SOME_SECRET_NAME=value, where the name suggests a credential
  { label: ".env-style secret assignment", regex: /^[ \t]*[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*\S+/gim },
  { label: "generic bearer token", regex: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g },
];

/**
 * Scans text for anything that looks like a credential. Returns an empty
 * array when nothing is found.
 */
export function scanForSecrets(text: string): SecretFinding[] {
  if (!text) {return [];}
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  for (const { label, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const raw = match[0];
      const key = `${label}:${raw}`;
      if (seen.has(key)) {continue;}
      seen.add(key);
      findings.push({ label, preview: redact(raw) });
      // Guard against pathological input / catastrophic match counts.
      if (findings.length > 25) {return findings;}
    }
  }

  return findings;
}

/** Redacts a matched string down to a short, non-reversible preview. */
function redact(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) {return "****";}
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/**
 * Returns text with secret-like substrings replaced by placeholders, plus
 * the findings list. Use this before sending file/terminal content to a model.
 */
export function redactSecretsInText(text: string): { text: string; findings: SecretFinding[] } {
  if (!text) {
    return { text: text || "", findings: [] };
  }
  const findings = scanForSecrets(text);
  if (findings.length === 0) {
    return { text, findings };
  }
  let out = text;
  for (const { label, regex } of PATTERNS) {
    regex.lastIndex = 0;
    out = out.replace(regex, (raw) => `[REDACTED:${label}:${redact(raw)}]`);
  }
  return { text: out, findings };
}

/**
 * Produces a single-line, human-readable summary of findings, suitable for
 * a status/warning message. Returns "" when there's nothing to report.
 */
export function summarizeFindings(findings: SecretFinding[], sourceLabel: string): string {
  if (findings.length === 0) {return "";}
  const labels = Array.from(new Set(findings.map((f) => f.label)));
  const labelText = labels.length <= 3 ? labels.join(", ") : `${labels.slice(0, 3).join(", ")}, +${labels.length - 3} more`;
  return `⚠️ Possible secret detected in ${sourceLabel} (${labelText}) — it was still included. Consider removing it before continuing.`;
}