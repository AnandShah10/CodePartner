/**
 * Phase 2 — rank / re-order context candidates using symbol hits and
 * simple path heuristics so the best evidence packs first under a token budget.
 */

export interface RankableChunk {
  path: string;
  score: number;
  excerpt: string;
}

/**
 * Boost semantic hits whose path appears in symbol-definition paths or
 * whose basename matches identifiers from the query.
 */
export function boostBySymbols(
  results: RankableChunk[],
  symbolPaths: string[],
  identifiers: string[]
): RankableChunk[] {
  const pathSet = new Set(symbolPaths.map((p) => p.replace(/\\/g, "/").toLowerCase()));
  const idLower = identifiers.map((x) => x.toLowerCase());

  return results
    .map((r) => {
      let boost = 0;
      const p = r.path.replace(/\\/g, "/").toLowerCase();
      if (pathSet.has(p)) {
        boost += 0.35;
      }
      const base = p.split("/").pop() || "";
      for (const id of idLower) {
        if (id.length >= 3 && (base.includes(id) || p.includes(id))) {
          boost += 0.15;
          break;
        }
      }
      // Prefer source over tests slightly for implementation queries
      if (/\.(test|spec)\./i.test(p) || /__tests__/i.test(p)) {
        boost -= 0.05;
      }
      return { ...r, score: r.score + boost };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Pack chunks under an approximate token budget (chars/4).
 */
export function packToBudget(
  results: RankableChunk[],
  maxTokens: number
): RankableChunk[] {
  const out: RankableChunk[] = [];
  let used = 0;
  for (const r of results) {
    const cost = Math.ceil((r.path.length + r.excerpt.length) / 4);
    if (used + cost > maxTokens && out.length > 0) {
      break;
    }
    out.push(r);
    used += cost;
  }
  return out;
}


/**
 * Boost paths that appear in recent git history (relative paths).
 */
export function boostByRecentGit(
  results: RankableChunk[],
  recentRelPaths: string[]
): RankableChunk[] {
  if (!recentRelPaths.length) {
    return results;
  }
  const set = new Set(
    recentRelPaths.map((p) => p.replace(/\\/g, "/").toLowerCase())
  );
  return results
    .map((r) => {
      const p = r.path.replace(/\\/g, "/").toLowerCase();
      const boost = set.has(p) ? 0.25 : 0;
      return { ...r, score: r.score + boost };
    })
    .sort((a, b) => b.score - a.score);
}
