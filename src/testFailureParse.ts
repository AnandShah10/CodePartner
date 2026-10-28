/**
 * Phase 4 — lightweight test failure extraction for the verification loop.
 * Heuristic parsers for common Jest/Vitest/Mocha/pytest/Go styles.
 */

export interface TestFailureHint {
  summary: string;
  files: string[];
  /** Short actionable guidance for the agent */
  guidance: string;
}

/**
 * Parse combined stdout/stderr from a test run into structured hints.
 */
export function parseTestFailures(output: string, exitCode: number | null): TestFailureHint | null {
  if (exitCode === 0 || !output) {
    return null;
  }
  const files = new Set<string>();
  const lines = output.split(/\r?\n/);

  // path:line patterns (TS/JS/Python/Go-ish)
  const pathRe =
    /(?:at\s+)?(?:file:\/\/)?([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java))(?::(\d+))?/g;
  for (const line of lines) {
    let m: RegExpExecArray | null;
    pathRe.lastIndex = 0;
    while ((m = pathRe.exec(line)) !== null) {
      const p = m[1].replace(/\\/g, "/");
      if (!p.includes("node_modules")) {
        files.add(p);
      }
    }
  }

  // FAIL / ● / Error: headlines
  const failLines = lines
    .filter((l) =>
      /^\s*(FAIL|✕|×|●|Error:|AssertionError|FAILED|FAILED\s)/i.test(l) ||
      /Expected:|Received:|assert\.|expect\(/.test(l)
    )
    .map((l) => l.trim())
    .slice(0, 12);

  const fileList = Array.from(files).slice(0, 10);
  if (failLines.length === 0 && fileList.length === 0) {
    return {
      summary: `Tests failed (exit ${exitCode}). No structured failure lines detected — inspect full output.`,
      files: [],
      guidance:
        "Re-read the full test output, open likely test files, fix the underlying source, then re-run the same test command.",
    };
  }

  const summaryParts = [
    `Tests failed (exit ${exitCode}).`,
    fileList.length ? `Related files: ${fileList.join(", ")}` : "",
    failLines.length ? `Signals:\n${failLines.map((l) => `  • ${l.slice(0, 160)}`).join("\n")}` : "",
  ].filter(Boolean);

  const testFiles = fileList.filter((f) =>
    /\.(test|spec)\.(t|j)sx?$|tests?/i.test(f)
  );
  const focused =
    testFiles.length === 1
      ? ` If your runner supports it, re-run just that file first (e.g. npx vitest run ${testFiles[0]} / npx jest ${testFiles[0]} / pytest ${testFiles[0]}).`
      : "";

  return {
    summary: summaryParts.join("\n"),
    files: fileList,
    guidance:
      fileList.length > 0
        ? `Read the failing files (${fileList.slice(0, 3).join(", ")}), fix the root cause, then re-run the **same** test command (or a focused file run) to verify.${focused}`
        : "Inspect the failure signals above, locate the source, fix, and re-run the same test command to verify.",
  };
}
