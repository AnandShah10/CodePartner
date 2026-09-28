/**
 * Copilot-style code-reference attribution helpers.
 *
 * Given a code snippet, find similar regions in workspace files using
 * normalized line shingles (no external index required). High similarity
 * hits are reported with path, line range, score, and nearby license
 * evidence when present.
 */

import { detectLicenseInText } from "./licenseScanner";

export interface CodeReferenceHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  preview: string;
  license?: string;
}

function normalizeLine(line: string): string {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/#.*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function shingles(lines: string[], size = 3): Set<string> {
  const norm = lines.map(normalizeLine).filter((l) => l.length > 2);
  const out = new Set<string>();
  if (norm.length === 0) {
    return out;
  }
  if (norm.length <= size) {
    out.add(norm.join("\n"));
    return out;
  }
  for (let i = 0; i <= norm.length - size; i++) {
    out.add(norm.slice(i, i + size).join("\n"));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) {
      inter++;
    }
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Compare a query snippet against one file's text. Returns best window match.
 */
export function findBestMatchInFile(
  query: string,
  fileText: string,
  path: string,
  minScore = 0.35
): CodeReferenceHit | null {
  const qLines = query.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (qLines.length < 2) {
    return null;
  }
  const qShingles = shingles(qLines);
  const fLines = fileText.split(/\r?\n/);
  const window = Math.max(qLines.length, 3);
  let best: CodeReferenceHit | null = null;

  for (let i = 0; i < fLines.length; i++) {
    const slice = fLines.slice(i, i + window);
    if (slice.every((l) => !l.trim())) {
      continue;
    }
    const score = jaccard(qShingles, shingles(slice));
    if (score < minScore) {
      continue;
    }
    if (!best || score > best.score) {
      const preview = slice
        .map((l) => l.trimEnd())
        .join("\n")
        .slice(0, 240);
      best = {
        path,
        startLine: i + 1,
        endLine: Math.min(i + window, fLines.length),
        score,
        preview,
      };
    }
  }

  if (best) {
    const lic = detectLicenseInText(fileText);
    if (lic) {
      best.license = lic.license;
    }
  }
  return best;
}

export function rankCodeReferences(
  query: string,
  files: { path: string; text: string }[],
  minScore = 0.35,
  maxHits = 10
): CodeReferenceHit[] {
  const hits: CodeReferenceHit[] = [];
  for (const f of files) {
    const hit = findBestMatchInFile(query, f.text, f.path, minScore);
    if (hit) {
      hits.push(hit);
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, maxHits);
}

export function formatCodeReferenceReport(hits: CodeReferenceHit[]): string {
  if (hits.length === 0) {
    return "No similar code found in the scanned workspace files (above similarity threshold).";
  }
  const lines = hits.map((h) => {
    const pct = Math.round(h.score * 100);
    const lic = h.license ? ` · license: ${h.license}` : "";
    return (
      `- **${h.path}:${h.startLine}-${h.endLine}** (${pct}% similar${lic})\n` +
      `  \`\`\`\n  ${h.preview.replace(/\n/g, "\n  ")}\n  \`\`\``
    );
  });
  return (
    `Found ${hits.length} similar region(s). Review before treating generated code as original:\n\n` +
    lines.join("\n\n")
  );
}
