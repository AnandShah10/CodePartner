import * as assert from "assert";
import { getScopedTools, SUBAGENT_TOOL_SCOPES } from "../subAgentTools";

const allTools = [
  { name: "run_command" }, { name: "read_file" }, { name: "edit_file" }, { name: "create_file" },
  { name: "web_search" }, { name: "list_dir" }, { name: "grep_search" }, { name: "run_tests" },
  { name: "query_knowledge" }, { name: "index_docs" }, { name: "commit_git_changes" }, { name: "call_subagent" },
];

suite("getScopedTools", () => {
  test("researcher gets read-only/search tools, not run_command or edit_file", () => {
    const scoped = getScopedTools("researcher", allTools).map((t) => t.name);
    assert.ok(scoped.includes("web_search"));
    assert.ok(scoped.includes("read_file"));
    assert.ok(!scoped.includes("run_command"));
    assert.ok(!scoped.includes("edit_file"));
  });

  test("code_expert gets file-write and shell access", () => {
    const scoped = getScopedTools("code_expert", allTools).map((t) => t.name);
    assert.ok(scoped.includes("edit_file"));
    assert.ok(scoped.includes("run_command"));
  });

  test("tester gets run_tests and run_command but not edit_file", () => {
    const scoped = getScopedTools("tester", allTools).map((t) => t.name);
    assert.ok(scoped.includes("run_tests"));
    assert.ok(scoped.includes("run_command"));
    assert.ok(!scoped.includes("edit_file"));
  });

  test("no sub-agent type gets call_subagent (no nested delegation) or git-write tools", () => {
    for (const agentType of Object.keys(SUBAGENT_TOOL_SCOPES)) {
      const scoped = getScopedTools(agentType, allTools).map((t) => t.name);
      assert.ok(!scoped.includes("call_subagent"), `${agentType} should not have call_subagent`);
      assert.ok(!scoped.includes("commit_git_changes"), `${agentType} should not have commit_git_changes`);
    }
  });

  test("an unrecognized agent type gets no tools at all", () => {
    assert.deepStrictEqual(getScopedTools("unknown_type", allTools), []);
  });
});