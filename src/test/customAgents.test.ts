import * as assert from "assert";
import { parseCustomAgentFile, resolveAgentTools, findUnknownAgentTools } from "../customAgents";

suite("parseCustomAgentFile", () => {
  test("parses name, description, tools, and instructions from a full file", () => {
    const content = `---
name: strict_reviewer
description: A strict, detail-oriented code reviewer for this repo
tools: read_file, list_dir, grep_search
---

You are a strict, detail-oriented code reviewer for this repository.
Focus on security issues and edge cases.`;
    const agent = parseCustomAgentFile("strict_reviewer", content);
    assert.ok(agent);
    assert.strictEqual(agent!.name, "strict_reviewer");
    assert.strictEqual(agent!.description, "A strict, detail-oriented code reviewer for this repo");
    assert.deepStrictEqual(agent!.tools, ["read_file", "list_dir", "grep_search"]);
    assert.ok(agent!.instructions.includes("Focus on security issues"));
    assert.ok(!agent!.instructions.includes("name: strict_reviewer"));
  });

  test("a missing tools field means no tool access (empty array), not an error", () => {
    const content = `---
name: documenter
description: Writes docs only, no tool access
---

You write clear documentation.`;
    const agent = parseCustomAgentFile("documenter", content);
    assert.deepStrictEqual(agent!.tools, []);
  });

  test("falls back to the filename when frontmatter has no name", () => {
    const content = `---
description: uses filename as name
---

Some instructions here.`;
    const agent = parseCustomAgentFile("my_agent_file", content);
    assert.strictEqual(agent!.name, "my_agent_file");
  });

  test("returns null when the file has no frontmatter at all", () => {
    assert.strictEqual(parseCustomAgentFile("x", "just plain text, no frontmatter"), null);
  });

  test("returns null when the body is empty", () => {
    const content = "---\nname: empty\n---\n\n   \n";
    assert.strictEqual(parseCustomAgentFile("x", content), null);
  });

  test("trims whitespace around each comma-separated tool name", () => {
    const content = `---
name: spacey
tools:  read_file ,  list_dir  ,run_command
---

Body text.`;
    const agent = parseCustomAgentFile("spacey", content);
    assert.deepStrictEqual(agent!.tools, ["read_file", "list_dir", "run_command"]);
  });
});

suite("resolveAgentTools / findUnknownAgentTools", () => {
  const allTools = [{ name: "read_file" }, { name: "list_dir" }, { name: "run_command" }, { name: "edit_file" }];

  test("resolveAgentTools filters to only matching, known tools", () => {
    const agent = { name: "a", description: "d", tools: ["read_file", "run_command", "nonexistent_tool"], instructions: "i" };
    assert.deepStrictEqual(resolveAgentTools(agent, allTools).map((t) => t.name), ["read_file", "run_command"]);
  });

  test("an agent with no declared tools resolves to no tools", () => {
    const agent = { name: "a", description: "d", tools: [], instructions: "i" };
    assert.deepStrictEqual(resolveAgentTools(agent, allTools), []);
  });

  test("findUnknownAgentTools flags a typo/nonexistent tool name", () => {
    const agent = { name: "a", description: "d", tools: ["read_file", "run_command", "nonexistent_tool"], instructions: "i" };
    assert.deepStrictEqual(findUnknownAgentTools(agent, allTools), ["nonexistent_tool"]);
  });

  test("findUnknownAgentTools returns empty when every declared tool is valid", () => {
    const agent = { name: "a", description: "d", tools: ["read_file"], instructions: "i" };
    assert.deepStrictEqual(findUnknownAgentTools(agent, allTools), []);
  });
});