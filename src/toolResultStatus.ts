/**
 * Determines whether a tool's result string represents success or
 * failure, for the timeline's success/fail indicator (Phase 4.2).
 *
 * The previous check was `!result.startsWith("Error")`, which works for
 * most tools (their failure paths do start with "Error") but not for
 * run_command / run_tests after the Phase 2.1/2.2 rewrite: those return
 * "Exit code: 1\n..." or "Tests failed (exit code 1)\n..." on a genuine
 * failure, neither of which starts with "Error" — so a failed shell
 * command or failing test suite was showing as a green/successful
 * timeline entry. This restores the exit-code and "Tests failed"
 * signal the roadmap's "duration + exit code shown, not just a text
 * preview" ask was actually about.
 */
export function isToolResultSuccess(result: unknown): boolean {
  if (typeof result !== "string") return true;
  if (result.startsWith("Error")) return false;
  if (result.startsWith("Denied:")) return false;
  if (/^Command timed out/.test(result)) return false;
  if (/^Tests timed out/.test(result)) return false;
  if (/^Tests failed/.test(result)) return false;
  const exitCodeMatch = result.match(/^Exit code: (-?\d+)/);
  if (exitCodeMatch && parseInt(exitCodeMatch[1], 10) !== 0) return false;
  return true;
}