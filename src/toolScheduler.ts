/**
 * Phase 1 — dependency-aware tool scheduling.
 *
 * Blind Promise.all over tool calls races same-file writes and can run
 * install+test out of order. This scheduler:
 *  - groups independent reads in parallel
 *  - serializes writes to the same path
 *  - runs shell/mutating sequences in call order when they share resources
 */

export type ScheduledTool = {
  id: string;
  name: string;
  /** Normalized path for file tools, if any */
  pathKey?: string;
  run: () => Promise<{ id: string; name: string; content: string }>;
};

const WRITE_TOOLS = new Set([
  "edit_file",
  "create_file",
  "write_ci_workflow",
]);

const SHELL_TOOLS = new Set([
  "run_command",
  "run_in_terminal",
  "run_tests",
  "send_terminal_input",
  "trigger_ci_workflow",
]);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name);
}

/**
 * Extract a stable path key from tool args (when present).
 */
export function pathKeyFromArgs(name: string, args: any): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const p = args.path ?? args.file ?? args.filePath;
  if (typeof p === "string" && p.trim()) {
    return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  }
  if (name === "write_ci_workflow" && typeof args.name === "string") {
    return `.github/workflows/${args.name}`.toLowerCase();
  }
  return undefined;
}

/**
 * Run tools with safe parallelism:
 * - Waves of tools that don't conflict (different paths, no shell coupling)
 * - Same pathKey writes always serial in original order
 * - Shell tools run serially relative to each other (order preserved)
 */
export async function runScheduledTools(
  tools: ScheduledTool[]
): Promise<Array<{ id: string; name: string; content: string }>> {
  if (tools.length === 0) {
    return [];
  }
  if (tools.length === 1) {
    return [await tools[0].run()];
  }

  // Build waves: greedy — take next tool if it doesn't conflict with any
  // already in the current wave.
  const remaining = tools.map((t, i) => ({ t, i }));
  const results: Array<{ id: string; name: string; content: string; order: number }> = [];

  while (remaining.length > 0) {
    const wave: typeof remaining = [];
    const wavePathWrites = new Set<string>();
    let waveHasShell = false;

    for (let k = 0; k < remaining.length; ) {
      const item = remaining[k];
      const { t } = item;
      const write = isWriteTool(t.name);
      const shell = isShellTool(t.name);
      let conflict = false;

      if (shell && waveHasShell) {
        conflict = true;
      }
      if (write && t.pathKey && wavePathWrites.has(t.pathKey)) {
        conflict = true;
      }
      // Shell after a write in same wave is OK only if different concerns;
      // keep shell out of waves that already have writes to be conservative.
      if (shell && wavePathWrites.size > 0) {
        conflict = true;
      }
      if (write && waveHasShell) {
        conflict = true;
      }

      if (!conflict) {
        wave.push(item);
        remaining.splice(k, 1);
        if (write && t.pathKey) {
          wavePathWrites.add(t.pathKey);
        }
        if (shell) {
          waveHasShell = true;
        }
      } else {
        k++;
      }
    }

    // If nothing could be taken (shouldn't happen), force one
    if (wave.length === 0 && remaining.length > 0) {
      wave.push(remaining.shift()!);
    }

    const waveResults = await Promise.all(
      wave.map(async ({ t, i }) => {
        const r = await t.run();
        return { ...r, order: i };
      })
    );
    results.push(...waveResults);
  }

  // Restore original tool-call order for history
  results.sort((a, b) => a.order - b.order);
  return results.map(({ id, name, content }) => ({ id, name, content }));
}
