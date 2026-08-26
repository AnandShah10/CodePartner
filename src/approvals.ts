/**
 * Approval policy for tool calls that can run a shell command, write a
 * file, or mutate git state. See extension.ts's executeTool() for where
 * this is enforced.
 *
 * Four tiers, from most to least gated:
 *  - "always-ask": every gated call (shell, file-write, git-write) prompts.
 *  - "ask-for-shell": only shell commands prompt; file/git writes proceed.
 *  - "full-auto": shell and file writes proceed unprompted; git writes
 *    still prompt, since they touch shared/remote history and are the
 *    hardest of the three categories to cleanly undo.
 *  - "yolo": nothing prompts. Deliberately named to be hard to select by
 *    accident (see confirmYoloModeIfNeeded in extension.ts, which requires
 *    an explicit modal confirmation before this takes effect).
 *
 * None of these tiers affect the prompt-injection override — see
 * promptInjectionGuard.ts — which forces a prompt regardless of policy.
 */
export type ApprovalPolicy = "always-ask" | "ask-for-shell" | "full-auto" | "yolo";

export type GatedCategory = "shell" | "file-write" | "git-write";

/** Tool names that require an approval gate, and which category they fall into. */
export const GATED_TOOLS: Record<string, GatedCategory> = {
  run_command: "shell",
  edit_file: "file-write",
  create_file: "file-write",
  commit_git_changes: "git-write",
  create_git_branch: "git-write",
  create_pull_request: "git-write",
};

/**
 * Whether a gated tool call needs an approval prompt under the given
 * policy alone (not accounting for the injection override or the
 * session allow-list, both handled by the caller).
 */
export function needsApprovalForPolicy(category: GatedCategory, policy: ApprovalPolicy): boolean {
  switch (policy) {
    case "yolo":
      return false;
    case "full-auto":
      return category === "git-write";
    case "ask-for-shell":
      return category === "shell";
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
    case "edit_file":
      return `Edit file: ${args?.path ?? "(unknown path)"}`;
    case "create_file":
      return `Create/overwrite file: ${args?.path ?? "(unknown path)"}`;
    case "commit_git_changes":
      return `Git commit: "${args?.message ?? ""}"`;
    case "create_git_branch":
      return `Create git branch: ${args?.name ?? "(unnamed)"}`;
    case "create_pull_request":
      return `Create pull request: "${args?.title ?? ""}"`;
    default:
      return `Run tool: ${name}`;
  }
}

/**
 * Extracts a session-allow-list key for a shell command: its first one or
 * two words (e.g. "git status", "npm test", "npm"). Matching is a prefix
 * check against this key, so approving "git status" once doesn't also
 * silently approve "git push --force" later.
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