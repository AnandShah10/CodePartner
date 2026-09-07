/**
 * Auto-triggers skills whose description keyword-overlaps with the
 * user's prompt, instead of requiring the model to remember to call
 * list_skills then use_skill. Mirrors how Claude Skills and Copilot's
 * Agent Skills auto-load based on relevance to the request.
 *
 * This is bag-of-words keyword overlap, not semantic/embedding matching
 * — this sandbox has no network access to compute or verify embeddings
 * against a real model, so a lightweight, deliberately simple and
 * auditable heuristic was the honest choice here over guessing at an
 * embedding approach I couldn't test.
 */

export interface SkillSummary {
  name: string;
  description: string;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with",
  "this", "that", "these", "those", "is", "are", "was", "were", "be",
  "been", "being", "it", "its", "as", "by", "your", "you", "i", "me",
  "my", "we", "our", "us", "at", "from", "into", "about", "using", "use",
]);

function stem(word: string): string {
  // Very lightweight suffix stripping — not a real stemmer, just enough
  // to stop "component" / "components" or "write" / "writing" from being
  // treated as unrelated tokens, which was a real false-negative source
  // in testing before this was added.
  if (word.endsWith("ies") && word.length > 4) {return word.slice(0, -3) + "y";}
  if (word.endsWith("ing") && word.length > 5) {return word.slice(0, -3);}
  if (word.endsWith("ed") && word.length > 4) {return word.slice(0, -2);}
  if (word.endsWith("es") && word.length > 4) {return word.slice(0, -2);}
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) {return word.slice(0, -1);}
  return word;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
      .map(stem)
  );
}

/**
 * Scores how relevant a skill is to a prompt: containment-style overlap —
 * matched keywords divided by the SMALLER of the prompt's and the
 * skill's keyword sets. Using the smaller set (rather than always the
 * skill's) means a short prompt sharing several of a skill's distinctive
 * keywords scores well even against a long description, instead of being
 * diluted by description text the prompt was never going to echo.
 * Returns a value in [0, 1]; 0 when either side has no meaningful
 * keywords, or there's no overlap at all.
 */
export function scoreSkillRelevance(prompt: string, skill: SkillSummary): number {
  const promptTerms = tokenize(prompt);
  const skillTerms = tokenize(`${skill.name} ${skill.description}`);
  if (skillTerms.size === 0 || promptTerms.size === 0) {return 0;}
  let matches = 0;
  for (const term of skillTerms) {
    if (promptTerms.has(term)) {matches++;}
  }
  const denom = Math.min(promptTerms.size, skillTerms.size);
  return matches / denom;
}

function countMatches(prompt: string, skill: SkillSummary): number {
  const promptTerms = tokenize(prompt);
  const skillTerms = tokenize(`${skill.name} ${skill.description}`);
  let matches = 0;
  for (const term of skillTerms) {
    if (promptTerms.has(term)) {matches++;}
  }
  return matches;
}

/**
 * Returns skills relevant enough to auto-load for this prompt: score at
 * or above `threshold` AND at least `minMatches` overlapping keywords
 * (the absolute-count guard prevents a single coincidental shared word
 * from triggering on a short, vague prompt), sorted most-relevant first,
 * capped to `maxSkills` so a broad prompt can't pull in the whole
 * skill library.
 */
export function findAutoTriggeredSkills(
  prompt: string,
  skills: SkillSummary[],
  threshold = 0.25,
  maxSkills = 2,
  minMatches = 2
): SkillSummary[] {
  return skills
    .map((skill) => ({ skill, score: scoreSkillRelevance(prompt, skill), matches: countMatches(prompt, skill) }))
    .filter((x) => x.score >= threshold && x.matches >= minMatches)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSkills)
    .map((x) => x.skill);
}