/**
 * A capped, most-recent-first list of actionable system diagnostics
 * (warnings/errors/info worth a user's attention — not routine spam).
 * Backs the webview's Agent Debug panel, alongside timeline tool history.
 */

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DiagnosticEntry {
  id: string;
  timestamp: number;
  severity: DiagnosticSeverity;
  /** Short label for where this came from, e.g. "Embeddings", "Terminal Assist", "Custom Agent". */
  source: string;
  message: string;
}

/** Snapshot pushed to the Agent Debug panel (mode, model, tokens, recent tools). */
export interface AgentDebugSnapshot {
  mode: string;
  model: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  chatId: string;
  planTasks: number;
  planDone: number;
  recentTools: {
    tool: string;
    success: boolean;
    duration: number;
    argsSummary: string;
    resultPreview: string;
    timestamp: number;
  }[];
  diagnostics: DiagnosticEntry[];
}

let nextDiagnosticId = 1;

/** Returns a NEW array with `entry` prepended (most recent first) and trimmed to `maxEntries`. */
export function addDiagnostic(
  list: DiagnosticEntry[],
  entry: { severity: DiagnosticSeverity; source: string; message: string },
  maxEntries = 150,
  now: number = Date.now()
): DiagnosticEntry[] {
  const full: DiagnosticEntry = {
    id: String(nextDiagnosticId++),
    timestamp: now,
    ...entry,
  };
  return [full, ...list].slice(0, maxEntries);
}
