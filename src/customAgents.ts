/**
 * Parses custom agent definition files — the repo-scoped equivalent of
 * Claude Code's SKILL.md / Copilot's .agent.md convention. Lets a repo
 * define its own named agent personas (system prompt + allowed tools)
 * instead of being limited to the four built-in sub-agent types
 * (researcher/code_expert/tester/writer).
 *
 * Format (frontmatter + body, matching the existing global-skills format
 * already used by SkillManager — same style, same familiarity):
 *
 *   ---
 *   name: strict_reviewer
 *   description: A strict, detail-oriented code reviewer for this repo
 *   tools: read_file, list_dir, grep_search
 *   ---
 *
 *   <system prompt / persona instructions as the file body>
 *
 * `tools` is optional and comma-separated; omitting it means no tool
 * access (the agent answers from reasoning only).
 */

export interface CustomAgentDefinition {
  name: string;
  description: string;
  tools: string[];
  instructions: string;
}

/** Parses one agent definition file's content. Returns null if the file has no frontmatter, no name, or an empty body. */
export function parseCustomAgentFile(fileNameWithoutExt: string, content: string): CustomAgentDefinition | null {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    return null;
  }
  const [, frontmatter, body] = frontmatterMatch;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (m) {fields[m[1].toLowerCase()] = m[2].trim();}
  }

  const name = (fields.name || fileNameWithoutExt).trim();
  const instructions = body.trim();
  if (!name || instructions.length === 0) {
    return null;
  }

  const tools = fields.tools
    ? fields.tools.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return {
    name,
    description: fields.description || "(no description)",
    tools,
    instructions,
  };
}

/** Filters a full tool list down to a custom agent's declared tool names. */
export function resolveAgentTools<T extends { name: string }>(agent: CustomAgentDefinition, allTools: T[]): T[] {
  if (agent.tools.length === 0) {return [];}
  const allowed = new Set(agent.tools);
  return allTools.filter((t) => allowed.has(t.name));
}

/** Tool names the agent declared that don't match any real tool — surfaces a likely typo in the .md file instead of silently granting nothing. */
export function findUnknownAgentTools<T extends { name: string }>(agent: CustomAgentDefinition, allTools: T[]): string[] {
  const known = new Set(allTools.map((t) => t.name));
  return agent.tools.filter((t) => !known.has(t));
}