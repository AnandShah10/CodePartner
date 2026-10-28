/**
 * Approval policy for tool calls that can run a shell command, write a
 * file, mutate git state, or invoke MCP tools with side effects.
 *
 * Phase 0 roadmap: capability-oriented gating — built-ins by name, MCP by
 * default category (external / unknown → treat as shell-equivalent risk).
 *
 * Four tiers, from most to least gated:
 *  - "always-ask": every gated call prompts.
 *  - "ask-for-shell": only shell (and MCP/external) prompt; file/git writes proceed.
 *  - "full-auto": shell and file writes proceed; git writes still prompt.
 *  - "yolo": nothing prompts (explicit modal confirmation required to enable).
 *
 * Prompt-injection override still forces a prompt regardless of policy.
 */

export type ApprovalPolicy = "always-ask" | "ask-for-shell" | "full-auto" | "yolo";

/** Capability buckets used for policy decisions. */
export type GatedCategory = "shell" | "file-write" | "git-write" | "external";

/** Built-in tools that require an approval gate. */
export const GATED_TOOLS: Record<string, GatedCategory> = {
  run_command: "shell",
  run_in_terminal: "shell",
  /** Typing into a live terminal is as powerful as running a command. */
  send_terminal_input: "shell",
  edit_file: "file-write",
  create_file: "file-write",
  commit_git_changes: "git-write",
  create_git_branch: "git-write",
  stage_git_changes: "git-write",
  create_pull_request: "git-write",
  run_parallel_agents: "git-write",
  write_ci_workflow: "file-write",
  trigger_ci_workflow: "shell",
  /** Browser can navigate/network and type into pages. */
  browser_control: "external",
};

/**
 * Resolve the gated category for any tool name.
 * MCP tools are treated as `external` (same policy weight as shell under
 * always-ask / ask-for-shell) unless a more specific map is provided later.
 */
export function resolveToolCategory(
  name: string,
  isMcpTool?: (n: string) => boolean
): GatedCategory | undefined {
  if (GATED_TOOLS[name]) {
    return GATED_TOOLS[name];
  }
  if (isMcpTool && isMcpTool(name)) {
    return "external";
  }
  return undefined;
}

/**
 * Whether a gated tool call needs an approval prompt under the given
 * policy alone (not accounting for injection override or session allow-list).
 */
export function needsApprovalForPolicy(category: GatedCategory, policy: ApprovalPolicy): boolean {
  switch (policy) {
    case "yolo":
      return false;
    case "full-auto":
      return category === "git-write";
    case "ask-for-shell":
      return category === "shell" || category === "external";
    case "always-ask":
    default:
      return true;
  }
}

/** Human-readable one-liner for the approval prompt. */
export function describeToolCall(name: string, args: any): string {
  switch (name) {
    case "run_command":
      return `Run shell command:\n${args?.command ?? "(no command given)"}`;
    case "run_in_terminal":
      return `Run in a visible terminal${args?.background ? " (background)" : ""}:\n${args?.command ?? "(no command given)"}`;
    case "send_terminal_input":
      return `Send input to terminal:\n${String(args?.text ?? "").slice(0, 200)}`;
    case "edit_file":
      return `Edit file: ${args?.path ?? "(unknown path)"}`;
    case "create_file":
      return `Create/overwrite file: ${args?.path ?? "(unknown path)"}`;
    case "commit_git_changes":
      return `Git commit: "${args?.message ?? ""}"`;
    case "create_git_branch":
      return `Create git branch: ${args?.name ?? "(unnamed)"}`;
    case "stage_git_changes":
      return `Stage all git changes`;
    case "create_pull_request":
      return `Create pull request: "${args?.title ?? ""}"`;
    case "browser_control":
      return `Browser ${args?.action ?? "action"}${args?.url ? `: ${args.url}` : ""}`;
    case "run_parallel_agents": {
      const count = Array.isArray(args?.tasks) ? args.tasks.length : 0;
      return `Run ${count} agent(s) in parallel, each in its own isolated git branch/worktree (won't touch your current working tree)`;
    }
    case "trigger_ci_workflow":
      return `Trigger CI workflow: ${args?.workflow ?? "(unknown)"}`;
    case "write_ci_workflow":
      return `Write CI workflow file: ${args?.name ?? "(unnamed)"}`;
    default:
      return `Run tool: ${name}${args ? `\nArgs: ${JSON.stringify(args).slice(0, 300)}` : ""}`;
  }
}

/**
 * Extracts a session-allow-list key for a shell command: its first one or
 * two words (e.g. "git status", "npm test", "npm").
 */
export function commandPrefix(command: string): string {
  const words = (command || "").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).join(" ");
}

/** True if `command` starts with an already-approved prefix (word-boundary safe). */
export function matchesApprovedPrefix(command: string, approvedPrefixes: Set<string>): boolean {
  const trimmed = (command || "").trim();
  for (const prefix of approvedPrefixes) {
    if (trimmed === prefix || trimmed.startsWith(prefix + " ")) {
      return true;
    }
  }
  return false;
}