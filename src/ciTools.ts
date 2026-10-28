/**
 * CI/CD helpers via the user's `gh` CLI (no CodePartner backend).
 * Requires GitHub CLI authenticated in the environment.
 */

import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";

function runGh(args: string[], cwd: string, timeoutMs = 60_000): { ok: boolean; out: string } {
  try {
    const out = cp.execFileSync("gh", args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    return { ok: true, out: String(out).trim() };
  } catch (e: any) {
    const stderr = e.stderr?.toString?.() || "";
    const stdout = e.stdout?.toString?.() || "";
    const msg = stderr || stdout || e.message || String(e);
    if (/spawn gh ENOENT|not found/i.test(msg) || e.code === "ENOENT") {
      return {
        ok: false,
        out: "GitHub CLI (`gh`) not found on PATH. Install https://cli.github.com and run `gh auth login`.",
      };
    }
    return { ok: false, out: msg };
  }
}

export function listCiRuns(cwd: string, limit = 10): string {
  const n = Math.min(Math.max(limit, 1), 30);
  const r = runGh(
    ["run", "list", "--limit", String(n), "--json", "databaseId,name,status,conclusion,headBranch,event,createdAt,url"],
    cwd
  );
  if (!r.ok) {
    return `Error listing CI runs: ${r.out}`;
  }
  try {
    const rows = JSON.parse(r.out || "[]") as any[];
    if (!rows.length) {
      return "No recent workflow runs.";
    }
    return rows
      .map(
        (x) =>
          `- #${x.databaseId} **${x.name}** [${x.status}${x.conclusion ? "/" + x.conclusion : ""}] branch=${x.headBranch} event=${x.event}\n  ${x.url}`
      )
      .join("\n");
  } catch {
    return r.out;
  }
}

export function triggerWorkflow(cwd: string, workflow: string, ref?: string): string {
  if (!workflow?.trim()) {
    return "Error: workflow name or file is required (e.g. ci.yml or \"CI\").";
  }
  const args = ["workflow", "run", workflow.trim()];
  if (ref?.trim()) {
    args.push("--ref", ref.trim());
  }
  const r = runGh(args, cwd, 90_000);
  if (!r.ok) {
    return `Error triggering workflow: ${r.out}`;
  }
  return `Triggered workflow "${workflow}"${ref ? ` on ref ${ref}` : ""}.\n${r.out || "OK — check GitHub Actions or use list_ci_runs."}`;
}

export function watchCiRun(cwd: string, runId?: string): string {
  const args = runId ? ["run", "watch", String(runId)] : ["run", "watch"];
  // watch can be long; use a shorter poll-friendly alternative
  const r = runGh(["run", "list", "--limit", "1", "--json", "databaseId,status,conclusion,name,url"], cwd);
  if (!r.ok) {
    return `Error: ${r.out}`;
  }
  return `Latest run:\n${r.out}\n(Use \`gh run watch\` in a terminal for live follow.)`;
}

/** Write a minimal GitHub Actions workflow file if missing. */
export function ensureGithubWorkflow(
  cwd: string,
  name: string,
  content: string
): string {
  const rel = name.includes("/") ? name : `.github/workflows/${name}`;
  const full = path.join(cwd, rel);
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full) && !content) {
      return `Workflow already exists: ${rel}`;
    }
    if (!content?.trim()) {
      content = `name: CI
on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      - run: npm test
`;
    }
    fs.writeFileSync(full, content, "utf8");
    return `Wrote ${rel}`;
  } catch (e: any) {
    return `Error writing workflow: ${e.message}`;
  }
}
