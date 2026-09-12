/**
 * A capped, most-recent-first list of actionable system diagnostics
 * (warnings/errors worth a user's attention — not routine info logging,
 * which stays in the output channel only). Backs the webview's
 * Diagnostics tab, alongside a client-side filter of failed timeline
 * events (no new data needed for that half — see main.js).
 */

export interface DiagnosticEntry {
  id: string;
  timestamp: number;
  severity: "warning" | "error";
  /** Short label for where this came from, e.g. "Embeddings", "Terminal Assist", "Custom Agent". */
  source: string;
  message: string;
}

let nextDiagnosticId = 1;

/** Returns a NEW array with `entry` prepended (most recent first) and trimmed to `maxEntries`. */
export function addDiagnostic(
  list: DiagnosticEntry[],
  entry: { severity: "warning" | "error"; source: string; message: string },
  maxEntries = 100,
  now: number = Date.now()
): DiagnosticEntry[] {
  const full: DiagnosticEntry = {
    id: String(nextDiagnosticId++),
    timestamp: now,
    ...entry,
  };
  return [full, ...list].slice(0, maxEntries);
}