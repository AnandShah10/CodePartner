/**
 * In-memory filtering and cache-freshness logic behind @-mention file
 * suggestions (Phase 3.7). Previously every keystroke in the prompt box
 * triggered a fresh `vscode.workspace.findFiles` glob scan of the whole
 * workspace — this splits that into "scan once, cache the listing" (the
 * vscode.workspace.findFiles call itself lives in extension.ts, since it
 * needs the real API) and "filter the cached listing in memory" (pure,
 * tested here).
 */

export interface CachedFile {
  relPath: string;
  fsPath: string;
}

export interface MentionCacheState {
  files: CachedFile[];
  fetchedAt: number;
}

/** Filters a cached file list by a case-insensitive substring match on the relative path, capped to maxResults. */
export function filterCachedFiles(files: CachedFile[], query: string, maxResults = 20): CachedFile[] {
  const q = query.toLowerCase();
  if (q === "") {
    return files.slice(0, maxResults);
  }
  const results: CachedFile[] = [];
  for (const f of files) {
    if (f.relPath.toLowerCase().includes(q)) {
      results.push(f);
      if (results.length >= maxResults) break;
    }
  }
  return results;
}

/** True if a cache entry is still fresh enough to use without a re-scan. */
export function isCacheFresh(state: MentionCacheState | null, maxAgeMs: number, now: number = Date.now()): boolean {
  if (!state) return false;
  return now - state.fetchedAt < maxAgeMs;
}