/**
 * Scoped tool access per sub-agent type (Phase 3.1).
 *
 * Previously call_subagent delegated to a single non-tool-using LLM call
 * — no sub-agent could read a file, run a command, or search the
 * workspace on its own, so "Multi-Agent" in the system prompt didn't
 * match what actually happened. Each type below can now only reach the
 * tools that fit its role.
 *
 * This is a genuine safety boundary, not just organization: any gated
 * action a sub-agent takes (a shell command, a file write) still goes
 * through the same approval gate as the main agent, since tool execution
 * for both is dispatched through the same executeTool() in extension.ts.
 * Restricting the tool list here means a "researcher" sub-agent can't
 * even be offered run_command as an option, on top of that gate.
 */

export const SUBAGENT_TOOL_SCOPES: Record<string, string[]> = {
  researcher: ["web_search", "query_knowledge", "index_docs", "read_file", "list_dir", "grep_search"],
  code_expert: ["read_file", "list_dir", "grep_search", "run_command", "edit_file", "create_file"],
  tester: ["read_file", "list_dir", "grep_search", "run_command", "run_tests"],
  writer: ["read_file", "list_dir", "grep_search", "create_file", "web_search"],
};

/** Filters a full tool list down to what `agentType` is allowed to use. An unrecognized type gets no tools (text-only). */
export function getScopedTools<T extends { name: string }>(agentType: string, allTools: T[]): T[] {
  const scope = SUBAGENT_TOOL_SCOPES[agentType];
  if (!scope) return [];
  return allTools.filter((t) => scope.includes(t.name));
}