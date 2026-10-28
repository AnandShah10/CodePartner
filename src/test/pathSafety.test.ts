import * as assert from "assert";
import * as path from "path";
import { resolveWorkspacePath, checkWorkspacePath, PathEscapeError } from "../pathSafety";
import { resolveToolCategory, GATED_TOOLS, needsApprovalForPolicy } from "../approvals";
import { redactSecretsInText } from "../secretScanner";

suite("Phase 0 — pathSafety", () => {
  const root = path.resolve("/tmp/cp-workspace-root");

  test("allows paths inside root", () => {
    const p = resolveWorkspacePath(root, "src/foo.ts");
    assert.ok(p.startsWith(root));
  });

  test("rejects .. escape", () => {
    assert.throws(() => resolveWorkspacePath(root, "../outside.txt"), PathEscapeError);
    assert.ok(checkWorkspacePath(root, "../../etc/passwd"));
  });
});

suite("Phase 0 — approvals", () => {
  test("send_terminal_input is shell-gated", () => {
    assert.strictEqual(GATED_TOOLS.send_terminal_input, "shell");
  });

  test("MCP tools resolve as external", () => {
    assert.strictEqual(resolveToolCategory("mcp_foo_bar", () => true), "external");
    assert.strictEqual(resolveToolCategory("read_file", () => false), undefined);
  });

  test("ask-for-shell gates external", () => {
    assert.strictEqual(needsApprovalForPolicy("external", "ask-for-shell"), true);
    assert.strictEqual(needsApprovalForPolicy("file-write", "ask-for-shell"), false);
  });
});

suite("Phase 0 — secret redaction", () => {
  test("redacts OpenAI-style keys", () => {
    const sample = "key=sk-abcdefghijklmnopqrstuvwxyz123456";
    const { text, findings } = redactSecretsInText(sample);
    assert.ok(findings.length >= 1);
    assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwxyz123456"));
    assert.ok(text.includes("REDACTED"));
  });
});

import { runScheduledTools, pathKeyFromArgs, ScheduledTool } from "../toolScheduler";

suite("Phase 1 — toolScheduler", () => {
  test("pathKeyFromArgs normalizes", () => {
    assert.strictEqual(pathKeyFromArgs("edit_file", { path: "./Src/Foo.ts" }), "src/foo.ts");
  });

  test("serializes same-path writes", async () => {
    const order: string[] = [];
    const mk = (id: string, name: string, path: string, delay: number): ScheduledTool => ({
      id,
      name,
      pathKey: pathKeyFromArgs(name, { path }),
      run: async () => {
        order.push(`start-${id}`);
        await new Promise((r) => setTimeout(r, delay));
        order.push(`end-${id}`);
        return { id, name, content: "ok" };
      },
    });
    // If parallel, end-a could interleave after start-b; with serial, end-a before start-b
    await runScheduledTools([
      mk("a", "edit_file", "same.ts", 30),
      mk("b", "edit_file", "same.ts", 5),
    ]);
    const endA = order.indexOf("end-a");
    const startB = order.indexOf("start-b");
    assert.ok(endA >= 0 && startB >= 0 && endA < startB, `order=${order.join(",")}`);
  });

  test("allows parallel different paths", async () => {
    const started: string[] = [];
    const mk = (id: string, p: string): ScheduledTool => ({
      id,
      name: "edit_file",
      pathKey: pathKeyFromArgs("edit_file", { path: p }),
      run: async () => {
        started.push(id);
        await new Promise((r) => setTimeout(r, 20));
        return { id, name: "edit_file", content: "ok" };
      },
    });
    await runScheduledTools([mk("x", "a.ts"), mk("y", "b.ts")]);
    assert.strictEqual(started.length, 2);
  });
});

suite("Phase 0 — approvals GATED_TOOLS", () => {
  test("send_terminal_input and browser gated", () => {
    assert.strictEqual(GATED_TOOLS.send_terminal_input, "shell");
    assert.strictEqual(GATED_TOOLS.browser_control, "external");
  });
});
