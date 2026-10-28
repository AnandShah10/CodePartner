/**
 * Git-sourced plugin / agent catalog (no marketplace backend).
 * Clones or pulls a public/private git repo into globalStorage and exposes
 * agent definition files alongside workspace `.codepartner/agents/`.
 */

import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import * as vscode from "vscode";
import { CustomAgentDefinition, parseCustomAgentFile } from "./customAgents";

const CATALOG_DIR_NAME = "plugin-catalog";

export function catalogRoot(globalStoragePath: string): string {
  return path.join(globalStoragePath, CATALOG_DIR_NAME);
}

/**
 * Sync `repoUrl` into globalStorage/plugin-catalog.
 * Uses shallow clone or pull. Returns a human-readable status string.
 */
export function syncPluginCatalog(
  globalStoragePath: string,
  repoUrl: string,
  branch?: string
): string {
  const url = (repoUrl || "").trim();
  if (!url) {
    return "Error: no catalog repo URL configured. Set codepartner.pluginCatalogRepo (e.g. https://github.com/org/codepartner-plugins).";
  }
  const dest = catalogRoot(globalStoragePath);
  try {
    fs.mkdirSync(globalStoragePath, { recursive: true });
  } catch {
    /* ignore */
  }

  const run = (cmd: string, cwd?: string): { ok: boolean; out: string } => {
    try {
      const out = cp.execSync(cmd, {
        cwd,
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, out: String(out).trim() };
    } catch (e: any) {
      const msg = e.stderr?.toString?.() || e.message || String(e);
      return { ok: false, out: msg };
    }
  };

  if (fs.existsSync(path.join(dest, ".git"))) {
    const pull = run(
      branch ? `git pull --ff-only origin ${branch}` : "git pull --ff-only",
      dest
    );
    if (!pull.ok) {
      return `Catalog pull failed: ${pull.out}`;
    }
    const agents = listCatalogAgents(globalStoragePath);
    return `Updated plugin catalog from ${url}. ${agents.length} agent definition(s) available.`;
  }

  if (fs.existsSync(dest)) {
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch (e: any) {
      return `Could not clear old catalog dir: ${e.message}`;
    }
  }

  const branchArg = branch ? ` --branch ${branch}` : "";
  const clone = run(`git clone --depth 1${branchArg} ${JSON.stringify(url)} ${JSON.stringify(dest)}`);
  if (!clone.ok) {
    return `Catalog clone failed: ${clone.out}`;
  }
  const agents = listCatalogAgents(globalStoragePath);
  return `Cloned plugin catalog from ${url}. ${agents.length} agent definition(s) available.`;
}

/** Load agent .md files from catalog (agents/ or root *.md). */
export function listCatalogAgents(globalStoragePath: string): CustomAgentDefinition[] {
  const root = catalogRoot(globalStoragePath);
  const dirs = [
    path.join(root, "agents"),
    path.join(root, ".codepartner", "agents"),
    root,
  ];
  const agents: CustomAgentDefinition[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      continue;
    }
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      // Skip README at catalog root
      if (dir === root && /^readme\.md$/i.test(f)) {
        continue;
      }
      try {
        const content = fs.readFileSync(path.join(dir, f), "utf8");
        const parsed = parseCustomAgentFile(f.replace(/\.md$/i, ""), content);
        if (parsed && !seen.has(parsed.name.toLowerCase())) {
          seen.add(parsed.name.toLowerCase());
          agents.push({
            ...parsed,
            description: `${parsed.description} [catalog]`,
          });
        }
      } catch {
        /* skip */
      }
    }
  }
  return agents;
}

export async function syncPluginCatalogCommand(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  const config = vscode.workspace.getConfiguration("codepartner");
  const repo = config.get<string>("pluginCatalogRepo") || "";
  const branch = config.get<string>("pluginCatalogBranch") || "";
  const msg = syncPluginCatalog(context.globalStorageUri.fsPath, repo, branch || undefined);
  output.appendLine(`[CodePartner] ${msg}`);
  if (msg.startsWith("Error") || msg.includes("failed")) {
    vscode.window.showErrorMessage(msg);
  } else {
    vscode.window.showInformationMessage(msg);
  }
}
