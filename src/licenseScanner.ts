/**
 * Lightweight SPDX / common license-header detection for workspace files.
 * Used by the scan_licenses tool so the agent can flag missing or mixed
 * license headers before suggesting distribution-sensitive changes.
 */

export interface LicenseFinding {
  path: string;
  /** Detected SPDX id or common license name, or "unknown". */
  license: string;
  /** First matching line excerpt (trimmed). */
  evidence: string;
}

const HEADER_PATTERNS: { id: string; re: RegExp }[] = [
  { id: "MIT", re: /\bMIT\s+License\b|Permission is hereby granted, free of charge/i },
  { id: "Apache-2.0", re: /\bApache\s+License\b.*\b2\.0\b|Licensed under the Apache License/i },
  { id: "GPL-3.0", re: /\bGNU\s+GENERAL\s+PUBLIC\s+LICENSE\b.*Version 3|GPL-3\.0/i },
  { id: "GPL-2.0", re: /\bGNU\s+GENERAL\s+PUBLIC\s+LICENSE\b.*Version 2|GPL-2\.0/i },
  { id: "BSD-3-Clause", re: /\bBSD\s+3-Clause\b|Redistribution and use in source and binary forms/i },
  { id: "BSD-2-Clause", re: /\bBSD\s+2-Clause\b/i },
  { id: "MPL-2.0", re: /\bMozilla Public License\b.*\b2\.0\b|MPL-2\.0/i },
  { id: "ISC", re: /\bISC\s+License\b/i },
  { id: "Unlicense", re: /\bThis is free and unencumbered software released into the public domain\b|The Unlicense/i },
  { id: "SPDX", re: /SPDX-License-Identifier:\s*([A-Za-z0-9.\-+]+)/i },
];

/**
 * Scans the first ~4KB of file text for a known license header / SPDX tag.
 */
export function detectLicenseInText(text: string): { license: string; evidence: string } | null {
  if (!text) {
    return null;
  }
  const head = text.slice(0, 4096);
  for (const { id, re } of HEADER_PATTERNS) {
    const m = re.exec(head);
    if (m) {
      if (id === "SPDX" && m[1]) {
        return { license: m[1], evidence: m[0].trim().slice(0, 120) };
      }
      return { license: id, evidence: m[0].trim().slice(0, 120) };
    }
  }
  return null;
}

/**
 * Given a map of relative path → file text (caller limits how many files),
 * return license findings. Files with no detectable header are listed as
 * license "none" only when `includeMissing` is true.
 */
export function scanLicenseTexts(
  files: { path: string; text: string }[],
  includeMissing = false
): LicenseFinding[] {
  const out: LicenseFinding[] = [];
  for (const f of files) {
    const hit = detectLicenseInText(f.text);
    if (hit) {
      out.push({ path: f.path, license: hit.license, evidence: hit.evidence });
    } else if (includeMissing) {
      out.push({ path: f.path, license: "none", evidence: "" });
    }
  }
  return out;
}

export function summarizeLicenseFindings(findings: LicenseFinding[]): string {
  if (findings.length === 0) {
    return "No license headers detected in the scanned files.";
  }
  const byLicense = new Map<string, number>();
  for (const f of findings) {
    byLicense.set(f.license, (byLicense.get(f.license) || 0) + 1);
  }
  const summary = Array.from(byLicense.entries())
    .map(([id, n]) => `${id}: ${n}`)
    .join(", ");
  const samples = findings
    .slice(0, 15)
    .map((f) => `- ${f.path}: ${f.license}${f.evidence ? ` ("${f.evidence.slice(0, 60)}")` : ""}`)
    .join("\n");
  return `License scan (${findings.length} file(s)): ${summary}\n${samples}`;
}
