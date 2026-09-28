import * as vscode from "vscode";
import axios from "axios";
import { createParser } from "eventsource-parser";
import MarkdownIt = require("markdown-it");
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";
import * as os from "os";
import { GitManager } from "./git";
import { CodePartnerInlineCompletionProvider } from "./inlineCompletion";
import { SemanticSearch } from "./semanticSearch";
import { MCPManager } from "./mcp";
import { NextEditManager } from "./nextEdit";
import { applyEdit, NOT_FOUND } from "./editUtils";
import { scanForSecrets, summarizeFindings } from "./secretScanner";
import { ApprovalPolicy, GatedCategory, GATED_TOOLS, needsApprovalForPolicy, describeToolCall, commandPrefix, matchesApprovedPrefix } from "./approvals";
import { UntrustedContentTracker } from "./promptInjectionGuard";
import { repairJsonParse } from "./jsonRepair";
import { isGitRepo, createGitCheckpoint, restoreFileFromCheckpoint } from "./gitCheckpoint";
import { buildProviderRequest, extractNonStreamedText, extractToolCalls, extractAssistantMessage, ProviderMessage } from "./aiProviderAdapter";
import { getScopedTools } from "./subAgentTools";
import { diffLines, groupIntoHunks, applyAcceptedHunks } from "./lineDiff";
import { buildPlanFromTasks, validatePlanIndex } from "./planUtils";
import { estimateTokens, truncateToTokenBudget } from "./tokenEstimate";
import { findAutoTriggeredSkills } from "./skillAutoTrigger";
import { filterCachedFiles, isCacheFresh, MentionCacheState } from "./mentionCache";
import { isToolResultSuccess } from "./toolResultStatus";
import { scanLicenseTexts, summarizeLicenseFindings } from "./licenseScanner";
import { rankCodeReferences, formatCodeReferenceReport } from "./codeReference";
import { AsyncAgentQueue } from "./asyncAgent";
import { listCatalogAgents, syncPluginCatalog, syncPluginCatalogCommand } from "./pluginCatalog";
import { listCiRuns, triggerWorkflow, ensureGithubWorkflow } from "./ciTools";
import { extractUsageFromStreamEvent, formatTokenCount } from "./usageExtraction";
import { getModelMetadata, formatContextWindow } from "./modelMetadata";
import { createWorktree, removeWorktree, getBranchDiffStat, commitAllIfDirty, toBranchSafeSegment } from "./gitWorktree";
import { stripAnsiCodes } from "./ansiStrip";
import { isFailureWorthAssisting, shouldOfferAssist, buildAssistPrompt, AssistOfferSignature } from "./terminalAssist";
import { CustomAgentDefinition, parseCustomAgentFile, resolveAgentTools, findUnknownAgentTools } from "./customAgents";
import { DiagnosticEntry, addDiagnostic, AgentDebugSnapshot } from "./diagnostics";

import { API_KEY_SECRET_KEY } from "./secretKeys";

/** Combines a spawned process's stdout/stderr into one trimmed string for display/prompt use. */
function formatOutput(stdout: string, stderr: string): string {
  const parts = [stdout.trim()];
  if (stderr.trim()) {
    parts.push(`STDERR:\n${stderr.trim()}`);
  }
  return parts.filter(Boolean).join("\n\n").trim();
}

/** Phase 3.7: how long the @-mention file listing cache is trusted before a re-scan, if no invalidating file-system event fired first. */
const MENTION_CACHE_TTL_MS = 30000;

class SingleContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChange.event;

  constructor(private content: string) { }

  provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken
  ): string {
    return this.content;
  }
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

// ─── Diff Provider ────────────────────────────────────────────────────────────
class CodePartnerDiffProvider implements vscode.TextDocumentContentProvider {
  public static scheme = "codepartner-diff";
  private _content = "";
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(_uri: vscode.Uri): string {
    return this._content;
  }

  update(content: string) {
    this._content = content;
    this._onDidChange.fire(
      vscode.Uri.parse(`${CodePartnerDiffProvider.scheme}:Proposed_Change`)
    );
  }
}

const diffProvider = new CodePartnerDiffProvider();

// ─── Agent & Artifact Managers ────────────────────────────────────────────────
interface SubAgentTask {
  id: string;
  agentType: string;
  task: string;
  personality?: string;
  status: "pending" | "running" | "done" | "error";
  result?: string;
}

class ArtifactRegistry {
  private artifacts: Map<string, any> = new Map();
  private baseDir: string;

  constructor() {
    const homeDir = os.homedir();
    this.baseDir = path.join(homeDir, ".codepartner", "artifacts");
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public create(title: string, content: string, type: string) {
    const id = Date.now().toString();
    const fileName = `${id}_${title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.${type === "code" ? "txt" : type === "markdown" ? "md" : "log"}`;
    const filePath = path.join(this.baseDir, fileName);

    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`[ArtifactRegistry] Saved artifact to: ${filePath}`);

    const artifact = { id, title, type, content, filePath, timestamp: Date.now() };
    this.artifacts.set(id, artifact);
    return artifact;
  }

  public getAll() {
    return Array.from(this.artifacts.values());
  }
}

class AgentManager {
  private subagents: Map<string, SubAgentTask> = new Map();

  public async dispatch(agentType: string, task: string, provider: CodePartnerSidebarProvider, personality?: string): Promise<string> {
    const id = Math.random().toString(36).substring(7);
    const subtask: SubAgentTask = { id, agentType, task, personality, status: "pending" };
    this.subagents.set(id, subtask);

    provider.updateStatus(`Agent ${agentType} starting task: ${task.substring(0, 30)}...`);
    subtask.status = "running";

    // runInternalAgent now runs a real multi-turn, tool-using loop scoped
    // to this agentType (Phase 3.1) — see its doc comment in extension.ts.
    try {
      const result = await provider.runInternalAgent(agentType, task, personality);
      subtask.status = "done";
      subtask.result = result;
      return result;
    } catch (e: any) {
      subtask.status = "error";
      return `Error in sub-agent: ${e.message}`;
    }
  }
}

class SkillManager {
  constructor(private workspaceRoot: string) { }

  private getSkillsDir(): string {
    const homeDir = os.homedir();
    const dir = path.join(homeDir, ".codepartner", "skills");
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    return dir;
  }

  public createSkill(name: string, description: string, instructions: string): string {
    const fileName = `${name.replace(/\s+/g, "_").toLowerCase()}.md`;
    const fullPath = path.join(this.getSkillsDir(), fileName);
    const content = `---\nDescription: ${description}\n---\n\n${instructions}`;
    fs.writeFileSync(fullPath, content, "utf8");
    return `Skill "${name}" saved to ${fileName}`;
  }

  public useSkill(name: string): string {
    const fileName = `${name.replace(/\s+/g, "_").toLowerCase()}.md`;
    const fullPath = path.join(this.getSkillsDir(), fileName);
    if (!fs.existsSync(fullPath)) { return `Error: Skill "${name}" not found.`; }
    const content = fs.readFileSync(fullPath, "utf8");
    return `\n--- Skill: ${name} ---\n${content}\n\n`;
  }

  public listSkills(): any[] {
    const dir = this.getSkillsDir();
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".md"))
      .map(f => {
        const content = fs.readFileSync(path.join(dir, f), "utf8");
        const descMatch = content.match(/Description: (.*)/);
        return { name: f.replace(".md", ""), description: descMatch ? descMatch[1] : "No description" };
      });
  }
}

class BrowserManager {
  private browser: any;
  private currentPage: any;

  constructor(private workspaceRoot: string) { }

  private findChromePath(): string | null {
    const platform = process.platform;
    const candidates: string[] = [];
    if (platform === "win32") {
      candidates.push(
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe"
      );
    } else if (platform === "darwin") {
      candidates.push(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
      );
    } else {
      candidates.push(
        "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"
      );
    }
    for (const p of candidates) {
      if (fs.existsSync(p)) { return p; }
    }
    return null;
  }

  public async execute(action: string, url?: string, selector?: string, text?: string): Promise<string> {
    const chromePath = this.findChromePath();
    if (!chromePath) {
      return "Error: No Chrome/Chromium browser found. Install Chrome or set the path manually.";
    }

    const puppeteer = require("puppeteer-core");
    if (!this.browser) {
      try {
        this.browser = await puppeteer.launch({ executablePath: chromePath, headless: "new" });
      } catch {
        try {
          this.browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
        } catch (e: any) {
          return `Browser launch error: ${e.message}`;
        }
      }
    }

    // Use persistent page for interactive actions
    if (!this.currentPage || action === "navigate") {
      if (this.currentPage) { await this.currentPage.close().catch(() => { }); }
      this.currentPage = await this.browser.newPage();
    }
    const page = this.currentPage;

    try {
      switch (action) {
        case "navigate": {
          if (!url) { return "Error: URL required for navigate."; }
          await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });
          const title = await page.title();
          // @ts-ignore
          const fullContent: string = await page.evaluate(() => document.body.innerText);
          const { text: content, truncated } = truncateToTokenBudget(fullContent, 1250); // ~ previous 5000-char cap
          const suffix = truncated ? "\n... (truncated — page content continues, use grep_search or a narrower selector for more)" : "";
          return `Navigated to ${url}. Title: ${title}\nContent Preview: ${content}${suffix}`;
        }
        case "screenshot": {
          if (url) { await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 }); }
          const id = Date.now().toString();
          const artifactDir = path.join(this.workspaceRoot, ".codepartner", "artifacts");
          if (!fs.existsSync(artifactDir)) { fs.mkdirSync(artifactDir, { recursive: true }); }
          const fileName = `screenshot_${id}.png`;
          const screenshotPath = path.join(artifactDir, fileName);
          await page.screenshot({ path: screenshotPath });
          const artifact = { id, title: `Screenshot: ${url || 'current page'}`, type: "screenshot", content: fileName, filePath: screenshotPath, timestamp: Date.now() };
          return JSON.stringify(artifact);
        }
        case "click": {
          if (!selector) { return "Error: selector required for click."; }
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.click(selector);
          await page.waitForNetworkIdle({ timeout: 3000 }).catch(() => { });
          // @ts-ignore
          const fullClickContent: string = await page.evaluate(() => document.body.innerText);
          const { text: clickContent, truncated: clickTruncated } = truncateToTokenBudget(fullClickContent, 750); // ~ previous 3000-char cap
          const clickSuffix = clickTruncated ? "\n... (truncated — page content continues)" : "";
          return `Clicked "${selector}". Page content after click:\n${clickContent}${clickSuffix}`;
        }
        case "type": {
          if (!selector || !text) { return "Error: selector and text required for type."; }
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.type(selector, text);
          return `Typed "${text}" into "${selector}".`;
        }
        case "wait_for": {
          if (!selector) { return "Error: selector required for wait_for."; }
          await page.waitForSelector(selector, { timeout: 10000 });
          return `Element "${selector}" found on page.`;
        }
        default:
          return `Unknown browser action: ${action}`;
      }
    } catch (e: any) {
      return `Browser error: ${e.message}`;
    }
  }
}

// ─── System Prompts ───────────────────────────────────────────────────────────
const BASE_SYSTEM = `You are CodePartner, a powerful agentic AI coding assistant.

Capabilities:
- **File Operations**: Read, edit (search/replace), create, and grep across files.
- **Shell Commands**: Run terminal commands in the workspace.
- **Multi-Agent**: Delegate to SubAgents (researcher, code_expert, tester, writer).
- **Browser**: Navigate and screenshot web pages.
- **Artifacts**: Save code, docs, or logs as persistent artifacts.
- **Web Search**: Search the web for information.
- **Git**: Check status, stage changes, create branches, and commit.

CRITICAL RULES:
1. **Always read before editing**: Use read_file before edit_file. Provide the EXACT text to search for.
2. **New files**: Use create_file, never edit_file for new files.
3. **Complete solutions**: Never truncate code blocks. Provide full, working implementations.
4. **Explain your reasoning**: Before making changes, briefly explain what you're doing and why.
5. **Use markdown**: Format responses with headers, code blocks, lists, and emphasis for readability.
6. **Error handling**: When a tool fails, explain the error and try an alternative approach.
7. **Be thorough**: Read relevant files, understand the codebase structure, then make targeted changes.
8. **Verify changes**: After editing files, consider running tests or reading the file to verify.
9. **Context matters**: Pay attention to the user's current file, selection, and workspace structure.
10. **Be proactive**: If you see related issues while working on a task, mention them.`;

const PLANNING_SYSTEM_PROMPT = BASE_SYSTEM + `\n\n## PLANNING MODE WORKFLOW
You MUST follow this exact multi-phase workflow. Each phase must complete before moving to the next.
You are ALREADY in Planning Mode — the user selected it. Do NOT ask whether to plan; always produce the plan first.

### Phase 1: RESEARCH (Mandatory First Step)
Before proposing ANY changes, you MUST thoroughly research:
- Use \`list_dir\` to understand project structure
- Use \`read_file\` to examine relevant source files
- Use \`grep_search\` to find related code, usages, and patterns
- Use \`web_search\` if external documentation or APIs are involved
- DO NOT make any code changes (no edit_file or create_file) during this phase

### Phase 2: IMPLEMENTATION PLAN (REQUIRED — Create Before Any Code Changes)
After research you MUST do BOTH of the following (in either order):
1. \`create_artifact\` with title containing "implementation_plan", type "markdown", describing goal, proposed changes, and verification.
2. \`create_plan\` with a non-empty ordered array of task description strings for the Plan panel (include @filename when a step targets a file).

**CRITICAL — ASK BEFORE EXECUTION:**
After creating the plan artifact and the structured checklist, you MUST STOP immediately and reply with:
"I have created the implementation plan. Please review it in the Plan / Artifacts tab and reply with 'proceed' to execute."
DO NOT call edit_file, create_file, or any mutating tool until the user explicitly approves with words like: proceed, approved, go ahead, yes, execute, or implement.

### Phase 3: EXECUTION (Only After User Approval)
Once the user says 'proceed', 'approved', 'go ahead', 'yes', 'execute', or similar:
- Execute changes one by one
- After finishing each step, call \`update_plan_task\` with that task's index and done=true so the Plan panel ticks the checkbox

### Phase 4: VERIFICATION & WALKTHROUGH
- Run tests if applicable
- Read modified files to verify correctness
- Create a "walkthrough" artifact summarizing changes made, what was tested, and validation results`;

const FAST_SYSTEM_PROMPT = BASE_SYSTEM + `\n\n## FAST MODE
Skip planning. Directly address the user's request using tools as needed.
Be concise and action-oriented. Do not generate implementation plans.`;

const ARCHITECT_SYSTEM_PROMPT = BASE_SYSTEM + `\n\n## ARCHITECT MODE
You are in Architect Mode. You MUST use the "edit_file" tool to draft changes.
These changes will be collected as drafts and NOT applied immediately. The user will review them.
Do NOT use "run_command" unless explicitly asked. Focus on generating code changes.`;

const TOOLS = [
  {
    name: "run_command",
    description: "Run a shell command in the workspace root, hidden from the user (runs in a spawned background process, not a visible terminal). Use this for routine commands. For anything the user should watch or might want to type into — dev servers, watch/build processes, interactive CLIs — use run_in_terminal instead.",
    parameters: { type: "object", properties: { command: { type: "string", description: "The command to run." } }, required: ["command"] },
  },
  {
    name: "run_in_terminal",
    description: "Runs a command in a VISIBLE terminal panel the user can see and interact with, unlike run_command which runs hidden. Use this for dev servers, watch/build processes, interactive CLIs, or anything long-running or worth the user's attention. Set background=true for a command that doesn't exit on its own (e.g. a dev server) to start it and return immediately without waiting for it to finish. Output/exit-code capture depends on VS Code's shell integration being available for the user's shell — when it isn't, the command still runs visibly but output can't be captured automatically. For typing into an already-running interactive process without starting a new command line, use send_terminal_input.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        background: { type: "boolean", description: "If true, start the command and return immediately without waiting for it to finish (for servers/watchers that run indefinitely). Default false." },
      },
      required: ["command"],
    },
  },
  {
    name: "send_terminal_input",
    description: "Type text into the visible CodePartner terminal (interactive). Use for answering prompts (y/n), entering passwords when the user asked, or sending keys to a running process. Set press_enter=true (default) to submit a line; false to type without Enter.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to send to the terminal." },
        press_enter: { type: "boolean", description: "If true (default), append Enter after the text." },
      },
      required: ["text"],
    },
  },
  {
    name: "list_dir",
    description: "List contents of a directory.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Relative path to the directory." } }, required: ["path"] },
  },
  {
    name: "read_file",
    description: "Read the contents of a file.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Relative path to the file." } }, required: ["path"] },
  },
  {
    name: "edit_file",
    description: "Edit a file using search/replace. The search string must match exactly. Always read_file first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file." },
        search: { type: "string", description: "Exact text block to find (must match file content exactly, including whitespace)." },
        replace: { type: "string", description: "Replacement text block." },
      },
      required: ["path", "search", "replace"],
    },
  },
  {
    name: "create_file",
    description: "Create a new file or overwrite an existing file entirely.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file." },
        content: { type: "string", description: "Full content for the file." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "web_search",
    description: "Search the web for information using DuckDuckGo.",
    parameters: { type: "object", properties: { query: { type: "string", description: "The search query." } }, required: ["query"] },
  },
  {
    name: "call_subagent",
    description: "Dispatch a specialized SubAgent to independently work a sub-task using its own tools and message history, scoped to its type: researcher (web search, docs, read-only file/code search), code_expert (read, edit, create files, run commands), tester (run tests/commands, read files), writer (create files, read files, web search). Request multiple call_subagent calls in one turn to run them concurrently. These agents SHARE the real workspace — for concurrent agents editing the same files, use run_parallel_agents instead. If the repo defines its own custom agent personas (.codepartner/agents/*.md), use list_custom_agents / call_custom_agent instead of one of these fixed built-in types.",
    parameters: {
      type: "object",
      properties: {
        agent_type: { type: "string", enum: ["researcher", "code_expert", "tester", "writer"], description: "Type of specialized agent." },
        task: { type: "string", description: "Specific instruction for the sub-agent." },
        personality: { type: "string", description: "Optional persona trait (e.g. 'Strict Reviewer', 'Creative Prototyper') to modify behavior." },
      },
      required: ["agent_type", "task"],
    },
  },
  {
    name: "list_custom_agents",
    description: "Lists custom agent personas the repo has defined in .codepartner/agents/*.md (name, description, and which tools each one has). Check this before assuming only the four built-in agent types (researcher/code_expert/tester/writer) are available — a repo may define its own, more specific personas.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "call_custom_agent",
    description: "Runs a repo-defined custom agent persona (from .codepartner/agents/*.md) as a multi-turn, tool-using sub-agent — same underlying mechanism as call_subagent, but the persona/system prompt and tool access come from the repo's own file instead of a fixed built-in type. Use list_custom_agents first to see what's defined.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The custom agent's name, from list_custom_agents." },
        task: { type: "string", description: "Specific instruction for the agent." },
      },
      required: ["name", "task"],
    },
  },
  {
    name: "run_parallel_agents",
    description: "Runs 2-8 sub-agents concurrently, each FULLY ISOLATED in its own git branch and checked-out worktree — unlike call_subagent, these can safely edit the same files without conflicting with each other or the user's real working tree, since each operates on its own copy of the repo. Use this for trying several independent approaches to the same problem side by side (e.g. different implementations, different fixes) so the user can compare and pick one. Requires the workspace to be a git repository. Nothing is merged or applied automatically — each agent's branch is left in place with a diff summary for the user to review and merge manually.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              agent_type: { type: "string", enum: ["researcher", "code_expert", "tester", "writer"] },
              task: { type: "string", description: "Specific instruction for this agent — should be independent of the other agents' tasks." },
              personality: { type: "string" },
            },
            required: ["agent_type", "task"],
          },
          description: "2-8 independent tasks to run in parallel, each in its own isolated branch.",
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "create_artifact",
    description: "Record a code snippet, documentation, or result as an artifact for the user.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Description of the artifact." },
        content: { type: "string", description: "The actual code or text." },
        type: { type: "string", enum: ["code", "markdown", "log"], description: "Format of the artifact." },
      },
      required: ["title", "content", "type"],
    },
  },
  {
    name: "create_plan",
    description: "Create or replace the structured task checklist shown in the Plan panel, as a JSON array of task descriptions. Call once, after research, with the full ordered list of implementation steps. Use update_plan_task to mark steps done as you complete them.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Ordered list of concise, one-line task descriptions.",
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "update_plan_task",
    description: "Mark a task in the current plan done or not done, by its 0-based index.",
    parameters: {
      type: "object",
      properties: {
        index: { type: "number", description: "0-based index of the task in the plan." },
        done: { type: "boolean", description: "Whether the task is now complete." },
      },
      required: ["index", "done"],
    },
  },
  {
    name: "create_skill",
    description: "Save a reusable set of instructions or workflow as a skill.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the skill." },
        description: { type: "string", description: "What this skill does." },
        instructions: { type: "string", description: "The actual prompt or instructions for this skill." },
      },
      required: ["name", "description", "instructions"],
    },
  },
  {
    name: "use_skill",
    description: "Retrieve instructions from a previously saved skill by name. Note: skills whose description keyword-matches the user's current message are already auto-loaded into context at the start of the turn — check context before assuming you need this. Use this for a skill that didn't auto-trigger, or one you want by exact name.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the skill to use." },
      },
      required: ["name"],
    },
  },
  {
    name: "list_skills",
    description: "List all currently available skills (name + description) to see what exists, e.g. before deciding whether to create a new one or call use_skill on an existing one that didn't auto-trigger.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "browser_control",
    description: "Control a browser: navigate to URLs, take screenshots, click elements, type text, and wait for elements.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "screenshot", "click", "type", "wait_for"], description: "Browser action to perform." },
        url: { type: "string", description: "Target URL (for navigate/screenshot)." },
        selector: { type: "string", description: "CSS selector for the target element (for click/type/wait_for)." },
        text: { type: "string", description: "Text to type (for type action)." },
      },
      required: ["action"],
    },
  },
  {
    name: "grep_search",
    description: "Search for a text pattern across files in the workspace. Returns matching lines with file paths and line numbers. Use this for finding function usages, variable references, or any text pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The text or regex pattern to search for." },
        path: { type: "string", description: "Relative path to search in (directory or file). Defaults to workspace root." },
        include: { type: "string", description: "File glob filter, e.g. '*.ts' or '*.py'. Defaults to all files." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "scan_licenses",
    description: "Scan workspace source files for SPDX identifiers and common license headers (MIT, Apache-2.0, GPL, BSD, etc.). Use before distributing code or when checking license consistency.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative directory or file to scan. Defaults to workspace root." },
        include_missing: { type: "boolean", description: "If true, also list files with no detectable license header." },
        max_files: { type: "number", description: "Maximum number of files to scan (default 80)." },
      },
    },
  },
  {
    name: "scan_code_references",
    description: "Copilot-style attribution check: find workspace regions similar to a code snippet (shingle similarity). Reports path, lines, score, and license when known. Use before treating generated or pasted code as original.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Code snippet to check for similar existing code." },
        path: { type: "string", description: "Optional subdirectory to limit the scan." },
        min_score: { type: "number", description: "Minimum similarity 0-1 (default 0.35)." },
        max_files: { type: "number", description: "Max files to scan (default 100)." },
      },
      required: ["code"],
    },
  },
  {
    name: "run_tests",
    description: "Run the project's test suite. Auto-detects the test runner (jest, vitest, mocha, pytest, etc.) or accepts a custom command. Use this to verify changes.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Custom test command. If omitted, auto-detects from package.json or project structure." },
      },
    },
  },
  {
    name: "index_docs",
    description: "Index a web documentation URL for later querying. Scrapes the page and saves it to local knowledge base.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL of the documentation to index." },
        title: { type: "string", description: "A friendly name for this documentation." },
      },
      required: ["url", "title"],
    },
  },
  {
    name: "query_knowledge",
    description: "Search across indexed documentation and knowledge. Uses keyword matching to find relevant excerpts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query or keyword." },
      },
      required: ["query"],
    },
  },
  {
    name: "generate_commit_message",
    description: "Generates a conventional commit message based on staged git changes.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_git_status",
    description: "Returns the current git status of the workspace.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "create_git_branch",
    description: "Creates a new git branch.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the new branch." },
      },
      required: ["name"],
    },
  },
  {
    name: "stage_git_changes",
    description: "Stages all current changes in the git repository.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "commit_git_changes",
    description: "Commits staged changes to the git repository. If the user's request implies opening a PR (or after committing to a feature branch), consider offering create_pull_request as the next step rather than stopping at the local commit.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The commit message." },
      },
      required: ["message"],
    },
  },
  {
    name: "create_pull_request",
    description: "Push the current branch (setting upstream if needed) and create a GitHub pull request for it against a base branch. Requires GitHub authentication (VS Code will prompt to sign in if needed) and a GitHub remote. Fails clearly if the current branch is the same as the base branch — create a feature branch first.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "PR title." },
        body: { type: "string", description: "PR description." },
        base: { type: "string", description: "Base branch (default: main)." },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "run_async_agent",
    description: "Start a LOCAL background agent job in the extension host (no cloud). Returns a job id immediately; work continues while the user keeps coding. Does not survive VS Code exit. Use list_async_agents to check status/results.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short label for the job." },
        prompt: { type: "string", description: "Task instructions for the background agent." },
        agent_type: {
          type: "string",
          description: "Built-in type: researcher | code_expert | tester | writer (default code_expert).",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_async_agents",
    description: "List local background agent jobs and their status/results.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "sync_plugin_catalog",
    description: "Clone or update the git-sourced plugin/agent catalog (codepartner.pluginCatalogRepo) into extension storage. Agents appear via list_custom_agents.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_ci_runs",
    description: "List recent GitHub Actions workflow runs via the gh CLI (no CodePartner backend). Requires gh auth.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max runs (default 10)." },
      },
    },
  },
  {
    name: "trigger_ci_workflow",
    description: "Trigger a GitHub Actions workflow with gh workflow run. Requires gh auth.",
    parameters: {
      type: "object",
      properties: {
        workflow: { type: "string", description: "Workflow file or name (e.g. ci.yml)." },
        ref: { type: "string", description: "Git ref (branch/tag). Optional." },
      },
      required: ["workflow"],
    },
  },
  {
    name: "write_ci_workflow",
    description: "Create or overwrite a GitHub Actions workflow file under .github/workflows/. Pass empty content for a sensible Node CI default.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Filename e.g. ci.yml (or full path under .github/workflows/)." },
        content: { type: "string", description: "YAML content. Optional default Node CI template if omitted." },
      },
      required: ["name"],
    },
  },
];

// ─── Activate ─────────────────────────────────────────────────────────────────
/**
 * One-time migration: if a plaintext API key is still sitting in
 * settings.json (old versions stored it via codepartner.apiKey), move it
 * into SecretStorage and blank out the setting everywhere it's set.
 *
 * Settings Sync and workspace settings.json are not safe places for a
 * credential — SecretStorage is backed by the OS keychain and never syncs
 * as plaintext.
 */
async function migrateApiKeyToSecretStorage(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const config = vscode.workspace.getConfiguration("codepartner");
  const inspected = config.inspect<string>("apiKey");
  const plaintextValues = [
    { value: inspected?.globalValue, target: vscode.ConfigurationTarget.Global },
    { value: inspected?.workspaceValue, target: vscode.ConfigurationTarget.Workspace },
    { value: inspected?.workspaceFolderValue, target: vscode.ConfigurationTarget.WorkspaceFolder },
  ].filter((v) => typeof v.value === "string" && v.value.trim() !== "");

  if (plaintextValues.length === 0) {
    return;
  }

  // Only move it into SecretStorage if nothing is stored there yet, so we
  // never clobber a key the user has already set via the new command.
  const existingSecret = await context.secrets.get(API_KEY_SECRET_KEY);
  if (!existingSecret) {
    const newest = plaintextValues[0].value!.trim();
    await context.secrets.store(API_KEY_SECRET_KEY, newest);
    output.appendLine("[CodePartner] Migrated API key from settings.json to SecretStorage.");
  }

  for (const { target } of plaintextValues) {
    try {
      await config.update("apiKey", undefined, target);
    } catch {
      // Target scope may not apply (e.g. no workspace folder) — safe to ignore.
    }
  }
  output.appendLine("[CodePartner] Cleared plaintext API key from settings.");
  vscode.window.showInformationMessage(
    "CodePartner: your API key was moved out of settings.json into secure storage. Use \"CodePartner: Set API Key\" to update it going forward."
  );
}

/**
 * Phase 1.6 — the most permissive autonomy tier ("yolo") is deliberately
 * hard to enable by accident: every time it's active without having been
 * confirmed this session, show a blocking modal explaining exactly what
 * it does. Declining reverts the setting instead of silently proceeding.
 */
const YOLO_CONFIRMED_KEY = "codepartner.yoloConfirmedThisSession";

async function confirmYoloModeIfNeeded(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const config = vscode.workspace.getConfiguration("codepartner");
  const policy = config.get<string>("approvalPolicy");
  if (policy !== "yolo") {
    await context.workspaceState.update(YOLO_CONFIRMED_KEY, false);
    return;
  }
  const alreadyConfirmed = context.workspaceState.get<boolean>(YOLO_CONFIRMED_KEY, false);
  if (alreadyConfirmed) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    "CodePartner is set to \"Full Auto — No Confirmations.\" It will run shell commands, edit/create files, and make git commits, branches, and pull requests with NO approval prompts. (Actions whose content matches a web search, indexed doc, or @-mentioned file are still confirmed, as a prompt-injection safeguard.)",
    { modal: true },
    "I understand, enable it",
    "Revert to Always Ask"
  );
  if (choice === "I understand, enable it") {
    await context.workspaceState.update(YOLO_CONFIRMED_KEY, true);
    output.appendLine("[CodePartner] Full Auto (\"yolo\") mode confirmed by user.");
  } else {
    await config.update("approvalPolicy", "always-ask", vscode.ConfigurationTarget.Global);
    output.appendLine("[CodePartner] Full Auto (\"yolo\") mode declined — reverted to always-ask.");
  }
}

/** Shows a persistent status bar warning while approvalPolicy is "yolo". */
function updateAutonomyStatusBar(item: vscode.StatusBarItem): void {
  const policy = vscode.workspace.getConfiguration("codepartner").get<string>("approvalPolicy");
  if (policy === "yolo") {
    item.text = "$(warning) CodePartner: FULL AUTO";
    item.tooltip = "No approval prompts for shell commands, file edits, or git operations. Click to review settings.";
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    item.command = "workbench.action.openSettings";
    item.show();
  } else {
    item.hide();
  }
}

/**
 * Terminal inline assist's "all-terminals" scope means CodePartner is
 * watching everything typed into every terminal in the workspace, not
 * just its own — a real permission, same reasoning as yolo mode above:
 * confirm it explicitly the first time it's active each session, and
 * revert rather than silently proceed if declined.
 */
const TERMINAL_ASSIST_ALL_CONFIRMED_KEY = "codepartner.terminalAssistAllConfirmedThisSession";

async function confirmAllTerminalsAssistIfNeeded(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const config = vscode.workspace.getConfiguration("codepartner");
  const setting = config.get<string>("terminalInlineAssist");
  if (setting !== "all-terminals") {
    await context.workspaceState.update(TERMINAL_ASSIST_ALL_CONFIRMED_KEY, false);
    return;
  }
  const alreadyConfirmed = context.workspaceState.get<boolean>(TERMINAL_ASSIST_ALL_CONFIRMED_KEY, false);
  if (alreadyConfirmed) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    "CodePartner's terminal assist is set to watch ALL terminals in this workspace — not just its own. When any command fails (including ones you type yourself), it'll offer to help, using the failed command and its output. Nothing is sent anywhere unless you click \"Ask CodePartner\" on that offer.",
    { modal: true },
    "I understand, enable it",
    "Revert to CodePartner-only"
  );
  if (choice === "I understand, enable it") {
    await context.workspaceState.update(TERMINAL_ASSIST_ALL_CONFIRMED_KEY, true);
    output.appendLine("[CodePartner] All-terminals inline assist confirmed by user.");
  } else {
    await config.update("terminalInlineAssist", "codepartner-only", vscode.ConfigurationTarget.Global);
    output.appendLine("[CodePartner] All-terminals inline assist declined — reverted to codepartner-only.");
  }
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("CodePartner");
  context.subscriptions.push(output);
  output.appendLine("CodePartner v2.0 extension activated.");

  migrateApiKeyToSecretStorage(context, output).catch((e) => {
    output.appendLine(`[CodePartner] API key migration error: ${e.message}`);
  });

  const autonomyStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  context.subscriptions.push(autonomyStatusBarItem);
  confirmYoloModeIfNeeded(context, output).then(() => updateAutonomyStatusBar(autonomyStatusBarItem));
  confirmAllTerminalsAssistIfNeeded(context, output);

  // Phase 4.1: session token-usage counter. Hidden until the first real
  // usage data arrives (see updateTokenStatusBar in the provider class).
  const tokenStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
  tokenStatusBarItem.name = "CodePartner Token Usage";
  context.subscriptions.push(tokenStatusBarItem);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      CodePartnerDiffProvider.scheme,
      diffProvider
    )
  );

  const provider = new CodePartnerSidebarProvider(context, output, tokenStatusBarItem);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codepartner-sidebar", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codepartner")) {
        provider.refreshModels();
        provider.applyEmbeddingConfig().catch(() => {});
        confirmYoloModeIfNeeded(context, output).then(() => updateAutonomyStatusBar(autonomyStatusBarItem));
        confirmAllTerminalsAssistIfNeeded(context, output);
      }
    })
  );

  // Phase 3.7: invalidate the @-mention file cache on any workspace file
  // create/delete/rename, so it can't serve a stale listing for longer
  // than MENTION_CACHE_TTL_MS would already bound it to. A broad watcher
  // pattern is fine here — invalidation is just clearing one in-memory
  // field, not a rescan; the rescan itself only happens lazily on the
  // next @-mention request.
  const mentionWatcher = vscode.workspace.createFileSystemWatcher("**/*");
  context.subscriptions.push(mentionWatcher);
  context.subscriptions.push(mentionWatcher.onDidCreate(() => provider.invalidateMentionCache()));
  context.subscriptions.push(mentionWatcher.onDidDelete(() => provider.invalidateMentionCache()));
  context.subscriptions.push(vscode.workspace.onDidRenameFiles(() => provider.invalidateMentionCache()));

  /**
   * Terminal inline assist: offers to help when a terminal command
   * fails. Scope (own terminal only, or all terminals in the workspace)
   * is gated by codepartner.terminalInlineAssist, defaulting to
   * "disabled" — see confirmAllTerminalsAssistIfNeeded above for why the
   * broader "all-terminals" scope gets its own one-time confirmation.
   *
   * VERIFICATION NOTE: same caveat as run_in_terminal — this depends on
   * VS Code's Terminal Shell Integration API (onDidStartTerminalShellExecution,
   * onDidEndTerminalShellExecution), which I could not compile or run
   * against real typings/a live host in this sandbox. Wrapped in
   * try/catch so a wrong assumption here disables the feature silently
   * (logged, not thrown) rather than breaking activation.
   */
  try {
    const terminalOutputBuffers = new WeakMap<vscode.TerminalShellExecution, string>();
    const terminalIds = new WeakMap<vscode.Terminal, number>();
    let nextTerminalId = 1;
    let lastAssistOffer: AssistOfferSignature | null = null;

    const getTerminalId = (terminal: vscode.Terminal): string => {
      let id = terminalIds.get(terminal);
      if (id === undefined) {
        id = nextTerminalId++;
        terminalIds.set(terminal, id);
      }
      return String(id);
    };

    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution((e) => {
        terminalOutputBuffers.set(e.execution, "");
        (async () => {
          try {
            for await (const chunk of e.execution.read()) {
              terminalOutputBuffers.set(e.execution, (terminalOutputBuffers.get(e.execution) || "") + chunk);
            }
          } catch {
            // Reading can fail if the terminal closes mid-command, etc. —
            // safe to ignore; the assist offer just won't have output.
          }
        })();
      })
    );

    context.subscriptions.push(
      vscode.window.onDidEndTerminalShellExecution((e) => {
        const setting = vscode.workspace.getConfiguration("codepartner").get<string>("terminalInlineAssist") || "disabled";
        if (setting === "disabled") {
          terminalOutputBuffers.delete(e.execution);
          return;
        }
        if (setting === "codepartner-only" && !provider.isOwnTerminal(e.terminal)) {
          terminalOutputBuffers.delete(e.execution);
          return;
        }
        if (!isFailureWorthAssisting(e.exitCode)) {
          terminalOutputBuffers.delete(e.execution);
          return;
        }

        const commandLine = e.execution.commandLine?.value || "(unknown command)";
        const capturedOutput = terminalOutputBuffers.get(e.execution) || "";
        terminalOutputBuffers.delete(e.execution);

        const signature: AssistOfferSignature = {
          terminalId: getTerminalId(e.terminal),
          commandLine,
          exitCode: e.exitCode as number,
          timestamp: Date.now(),
        };
        if (!shouldOfferAssist(lastAssistOffer, signature)) {
          return;
        }
        lastAssistOffer = signature;

        const shortCommand = commandLine.length > 60 ? `${commandLine.slice(0, 60)}...` : commandLine;
        vscode.window.showInformationMessage(`Command failed (exit ${e.exitCode}): ${shortCommand}`, "Ask CodePartner")
          .then((choice) => {
            if (choice === "Ask CodePartner") {
              const cleaned = stripAnsiCodes(capturedOutput);
              provider.submitExternalPrompt(buildAssistPrompt(commandLine, e.exitCode as number, cleaned));
            }
          });
      })
    );
  } catch (e: any) {
    provider.logDiagnostic("error", "Terminal Assist", `Unavailable — shell integration API not present in this VS Code version: ${e.message}`);
  }

  // ── Inline Completion Provider ──
  const inlineProvider = new CodePartnerInlineCompletionProvider(context, output);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      inlineProvider
    )
  );

  // ── Next Edit Suggestions + Finish Changes ──
  const nextEditManager = new NextEditManager(output);
  context.subscriptions.push(nextEditManager);
  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.applyNextEdit", () =>
      nextEditManager.applyNextEdit()
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.finishChanges", () =>
      nextEditManager.applyAllPending()
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.dismissNextEdits", () =>
      nextEditManager.dismissPending()
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.focusTerminal", () => {
      provider.focusCodePartnerTerminal();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.syncPluginCatalog", () =>
      syncPluginCatalogCommand(context, output)
    )
  );

  // ── Commands ──
  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.focus", () => {
      vscode.commands.executeCommand("workbench.view.extension.codepartner-view-container");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.toggleInlineCompletions", () => {
      const config = vscode.workspace.getConfiguration("codepartner");
      const current = config.get<boolean>("inlineCompletions", false);
      config.update("inlineCompletions", !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`CodePartner: Inline completions ${!current ? "enabled" : "disabled"}.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.explainSelection", () => {
      provider.executeSlashCommand("explain");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.fixErrors", () => {
      provider.executeSlashCommand("fix");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.generateTests", () => {
      provider.executeSlashCommand("test");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.showDebugLog", () => {
      output.show(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.newChat", () => {
      provider.newChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.cancelActiveTask", () => {
      provider.cancelActiveTask();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "CodePartner: Set API Key",
        prompt: "Enter your LLM provider API key. It's stored in your OS keychain, never in settings.json.",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "sk-...",
      });
      if (key === undefined) {
        return; // User cancelled.
      }
      if (key.trim() === "") {
        await context.secrets.delete(API_KEY_SECRET_KEY);
        vscode.window.showInformationMessage("CodePartner: API key cleared.");
      } else {
        await context.secrets.store(API_KEY_SECRET_KEY, key.trim());
        vscode.window.showInformationMessage("CodePartner: API key saved securely.");
      }
      provider.refreshModels();
    })
  );

  output.appendLine("CodePartner: All providers and commands registered.");
}

export function deactivate() { }

// ─── Sidebar Provider ─────────────────────────────────────────────────────────
class CodePartnerSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private messageHistory: any[] = [];
  private abortController?: AbortController;
  private currentChatId: string;
  private selectedModelId?: string;
  private availableModels: any[] = [];
  private modifiedFiles: Set<string> = new Set();
  private fileBackups: Map<string, string> = new Map();
  private fileChangeStats: Map<string, { added: number, removed: number }> = new Map();
  // Phase 1 — permission model state (session-scoped: resets on window/extension reload).
  private approvedCommandPrefixes: Set<string> = new Set();
  private sessionAutoApprove: { fileWrite: boolean; gitWrite: boolean } = { fileWrite: false, gitWrite: false };
  private untrustedContent = new UntrustedContentTracker();
  /**
   * Phase 3.7: cached workspace file listing for @-mention suggestions,
   * replacing a fresh vscode.workspace.findFiles glob scan on every
   * keystroke. Invalidated by the file-watcher registered in activate()
   * and by a TTL as a fallback (see MENTION_CACHE_TTL_MS / getCachedWorkspaceFiles).
   */
  private mentionFileCache: MentionCacheState | null = null;
  /**
   * Diagnostics panel: a capped, most-recent-first log of actionable
   * warnings/errors (not routine info logging, which stays in the output
   * channel only) — distinct from timelineEvents' failed tool calls,
   * which the Diagnostics tab shows alongside this via a client-side
   * filter (no separate backend data needed for that half).
   */
  private diagnostics: DiagnosticEntry[] = [];
  /**
   * Per-turn git checkpoint fallback (Phase 2.4): turnId -> stash-create
   * SHA ("" means the tree was clean at checkpoint time, i.e. == HEAD).
   * Used by revertTimelineAction/revertTurn only when the primary
   * revertContent backup for a given edit isn't available.
   */
  private turnGitCheckpoints: Map<string, string> = new Map();
  private agentManager: AgentManager;
  private artifactRegistry?: ArtifactRegistry;
  private browserManager?: BrowserManager;
  private currentPlan: { task: string, done: boolean }[] = [];
  private currentArtifacts: any[] = [];
  private timelineEvents: any[] = [];
  private suggestedWorkflows: Set<string> = new Set();
  private suggestedSkillsCount: number = 0;
  private executionMode: "planning" | "fast" | "architect" = "fast";
  private skillManager?: SkillManager;
  private architectDrafts: Map<string, string> = new Map();
  /** The persistent, user-visible terminal used by run_in_terminal (Phase: interactive terminal). Distinct from the hidden spawned processes runCommand/runTests use. */
  private visibleTerminal?: vscode.Terminal;

  /** True if `terminal` is the one CodePartner itself created via run_in_terminal — used by the terminal inline assistant's "codepartner-only" scope. */
  public isOwnTerminal(terminal: vscode.Terminal): boolean {
    return terminal === this.visibleTerminal;
  }
  /** The currently in-flight shell command / test run, if any — killed on cancel (Phase 2.1/2.2). */
  private runningChildProcess?: cp.ChildProcess;
  private gitManager: GitManager;
  private semanticSearch: SemanticSearch;
  private mcpManager: MCPManager;
  private customInstructions: string = "";
  /** Local background agents (extension-host only; no cloud). */
  private asyncAgentQueue = new AsyncAgentQueue();
  /** Phase 4.1: cumulative real token usage for this session (from actual API usage data, not an estimate). */
  private sessionTokenUsage = { input: 0, output: 0 };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly tokenStatusBarItem?: vscode.StatusBarItem
  ) {
    this.currentChatId = Date.now().toString();
    this.messageHistory = [{ role: "system", content: FAST_SYSTEM_PROMPT }];
    this.agentManager = new AgentManager();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.artifactRegistry = new ArtifactRegistry();
    this.skillManager = new SkillManager(root || os.homedir());
    this.gitManager = new GitManager();
    this.semanticSearch = new SemanticSearch(output);
    this.mcpManager = new MCPManager(output);
    try {
      const persist = path.join(context.globalStorageUri.fsPath, "async-agent-jobs.json");
      this.asyncAgentQueue.setPersistPath(persist);
    } catch {
      /* storage path may be unavailable */
    }

    if (root) {
      this.browserManager = new BrowserManager(root);
    }

    // Load custom agent definitions (.codepartner.md)
    this.loadCustomInstructions();

    // Initialize MCP servers
    this.mcpManager.loadConfigs().catch((e: any) => {
      this.output.appendLine(`[CodePartner] MCP init error: ${e.message}`);
      this.logDiagnostic("error", "MCP", `Init failed: ${e.message}`);
    });

    // Build semantic search index in the background
    this.semanticSearch.buildIndex().catch(() => {});
    this.applyEmbeddingConfig().catch((e) => {
      this.output.appendLine(`[CodePartner] Embedding config error: ${e.message}`);
    });

    // Phase 4.3: restore the last selected model per workspace, so it
    // survives a VS Code restart instead of silently falling back to
    // codepartner.model every time.
    this.selectedModelId = this.context.workspaceState.get<string>("cp-selected-model-id") || undefined;

    // Try to restore last chat
    const lastChatId = this.context.workspaceState.get<string>("cp-last-chat-id");
    if (lastChatId) {
      this.currentChatId = lastChatId;
      const chats = this.context.workspaceState.get<any[]>("cp-chats", []);
      const chat = chats.find(c => c.id === lastChatId);
      if (chat) {
        this.messageHistory = chat.messages;
        this.currentPlan = chat.plan || [];
        this.currentArtifacts = chat.artifacts || [];
        // Bug: timelineEvents (and therefore every edit_file/create_file's
        // revertContent backup) was saved to workspaceState by
        // saveCurrentChat() but never read back in here, so the Timeline
        // "revert" button had nothing to revert after a reload even
        // though the backup data was sitting in storage the whole time.
        this.timelineEvents = chat.timeline || [];
        this.turnGitCheckpoints = new Map(chat.gitCheckpoints || []);
      }
    }
  }

  /**
   * Load custom instructions from .codepartner.md and global config.
   */
  private loadCustomInstructions(): void {
    let instructions = "";
    // Global instructions
    const globalPath = path.join(os.homedir(), ".codepartner", "global_instructions.md");
    if (fs.existsSync(globalPath)) {
      instructions += fs.readFileSync(globalPath, "utf8") + "\n\n";
      this.output.appendLine("[CodePartner] Loaded global custom instructions.");
    }
    // Workspace instructions
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      const wsPath = path.join(root, ".codepartner.md");
      if (fs.existsSync(wsPath)) {
        instructions += fs.readFileSync(wsPath, "utf8") + "\n\n";
        this.output.appendLine("[CodePartner] Loaded workspace .codepartner.md instructions.");
      }
    }
    this.customInstructions = instructions.trim();
  }

  /**
   * Execute a slash command programmatically (from keybindings or command palette).
   */
  public async executeSlashCommand(command: string): Promise<void> {
    // Ensure the sidebar is visible
    await vscode.commands.executeCommand("workbench.view.extension.codepartner-view-container");
    // Small delay to let webview initialize
    await new Promise(r => setTimeout(r, 300));
    this.handleSlashCommand(command);
  }

  /**
   * Reveals the sidebar and submits a full prompt as if the user had
   * typed and sent it — used by the terminal inline assistant's "Ask
   * CodePartner" action. Mirrors executeSlashCommand's reveal-then-wait
   * pattern, but calls handlePrompt directly since this is a full prompt
   * (a failed command + its output), not a "/command" shorthand.
   */
  public async submitExternalPrompt(promptText: string): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.codepartner-view-container");
    await new Promise(r => setTimeout(r, 300));
    this.handlePrompt(promptText);
  }

  public updateStatus(msg: string) {
    this._view?.webview.postMessage({ type: "status", value: msg });
  }

  /**
   * Logs an actionable warning/error to both the output channel (as
   * before — this doesn't replace that) and the Diagnostics tab, so it's
   * still visible after the transient status toast (if any) is gone.
   * Reserved for things worth a user's attention later, not routine info
   * logging — most output.appendLine calls elsewhere are left as-is on
   * purpose.
   */
  public logDiagnostic(
    severity: "info" | "warning" | "error",
    source: string,
    message: string
  ): void {
    this.output.appendLine(`[CodePartner] [${severity}] [${source}] ${message}`);
    this.diagnostics = addDiagnostic(this.diagnostics, { severity, source, message });
    this.pushAgentDebug();
  }

  /** Full Agent Debug panel snapshot (session + recent tools + diagnostics). */
  public pushAgentDebug(): void {
    if (!this._view) {
      return;
    }
    const config = vscode.workspace.getConfiguration("codepartner");
    const recent = this.timelineEvents.slice(-25).reverse().map((e) => ({
      tool: String(e.tool || ""),
      success: !!e.success,
      duration: Number(e.duration || 0),
      argsSummary: String(e.argsSummary || "").slice(0, 160),
      resultPreview: String(e.resultPreview || "").slice(0, 200),
      timestamp: Number(e.timestamp || 0),
    }));
    const planDone = this.currentPlan.filter((t) => t.done).length;
    const snap: AgentDebugSnapshot = {
      mode: this.executionMode,
      model: this.selectedModelId || config.get<string>("model") || "",
      provider: config.get<string>("provider") || "openai",
      tokensIn: this.sessionTokenUsage.input,
      tokensOut: this.sessionTokenUsage.output,
      chatId: this.currentChatId || "",
      planTasks: this.currentPlan.length,
      planDone,
      recentTools: recent,
      diagnostics: this.diagnostics,
    };
    this._view.webview.postMessage({ type: "agentDebug", value: snap });
    this._view.webview.postMessage({ type: "diagnostics", value: this.diagnostics });
  }

  /**
   * Phase 4.4: shows a one-time explanatory tip the first time a user
   * switches into a given mode, using globalState (not per-workspace) so
   * it doesn't re-appear in every new project once seen.
   */
  private showFirstRunTipIfNeeded(mode: "architect" | "planning", tip: string): void {
    const key = `cp-seen-tip-${mode}`;
    if (this.context.globalState.get<boolean>(key)) {
      return;
    }
    this.context.globalState.update(key, true);
    const label = mode === "architect" ? "Architect Mode" : "Planning Mode";
    vscode.window.showInformationMessage(`CodePartner — ${label} ${tip}`);
  }

  /**
   * Phase 4.1: refreshes the status bar with this session's real
   * cumulative token usage (from actual API usage data — see the doc
   * comment on usageExtraction.ts for why this shows token counts rather
   * than a dollar-cost estimate).
   */
  private updateTokenStatusBar(): void {
    if (!this.tokenStatusBarItem) {return;}
    const total = this.sessionTokenUsage.input + this.sessionTokenUsage.output;
    if (total === 0) {
      this.tokenStatusBarItem.hide();
      this.pushAgentDebug();
      return;
    }
    this.tokenStatusBarItem.text = `$(symbol-numeric) ${formatTokenCount(total)}`;
    this.tokenStatusBarItem.tooltip = `CodePartner session usage: ${this.sessionTokenUsage.input.toLocaleString()} input, ${this.sessionTokenUsage.output.toLocaleString()} output tokens (from provider-reported usage, this session only).`;
    this.tokenStatusBarItem.show();
    this.pushAgentDebug();
  }

  /**
   * Reads the LLM provider API key from SecretStorage. This is the only
   * supported way to read the key — see migrateApiKeyToSecretStorage() for
   * why it no longer lives in settings.json.
   */
  private async getApiKey(): Promise<string> {
    const key = await this.context.secrets.get(API_KEY_SECRET_KEY);
    return (key || "").trim();
  }

  /**
   * Reads embedding-search settings and pushes them into SemanticSearch.
   * Strictly opt-in — codepartner.embeddingProvider defaults to
   * "disabled", meaning TF-IDF-only, zero behavior/cost change from
   * before this feature existed. "same-as-chat" resolves to whatever
   * codepartner.provider is configured, EXCEPT Anthropic, which has no
   * embeddings endpoint — that case logs once and falls back to TF-IDF
   * (configureEmbeddings(null)) rather than trying and failing repeatedly.
   */
  public async applyEmbeddingConfig(): Promise<void> {
    const config = vscode.workspace.getConfiguration("codepartner");
    const setting = config.get<string>("embeddingProvider") || "disabled";

    if (setting === "disabled") {
      this.semanticSearch.configureEmbeddings(null);
      return;
    }

    let providerType: "openai" | "azure" | "google" | "ollama";
    if (setting === "same-as-chat") {
      const chatProvider = config.get<string>("provider") || "openai";
      if (chatProvider === "anthropic") {
        this.logDiagnostic("warning", "Embeddings", "embeddingProvider is \"same-as-chat\" but the chat provider (Anthropic) has no embeddings endpoint — using TF-IDF search instead. Set codepartner.embeddingProvider explicitly (e.g. \"openai\") to use embeddings anyway.");
        this.semanticSearch.configureEmbeddings(null);
        return;
      }
      if (chatProvider !== "openai" && chatProvider !== "azure" && chatProvider !== "google" && chatProvider !== "ollama") {
        // A custom/OpenAI-compatible chat endpoint — treat as openai-shaped.
        providerType = "openai";
      } else {
        providerType = chatProvider as "openai" | "azure" | "google" | "ollama";
      }
    } else if (setting === "openai" || setting === "azure" || setting === "google" || setting === "ollama") {
      providerType = setting;
    } else {
      this.semanticSearch.configureEmbeddings(null);
      return;
    }

    const apiKey = providerType === "ollama" ? "" : await this.getApiKey();
    const apiEndpoint = config.get<string>("embeddingEndpoint")?.trim() || (setting === "same-as-chat" ? config.get<string>("apiEndpoint")?.trim() || "" : "");
    const model = config.get<string>("embeddingModel")?.trim() || "";

    this.semanticSearch.configureEmbeddings({ providerType, apiEndpoint, apiKey, model });
  }

  /**
   * Scans text that's about to be sent somewhere external (an LLM prompt,
   * or a GitHub issue in the feedback path) for anything that looks like a
   * credential, and — if found — warns visibly without stripping it. See
   * secretScanner.ts for the rationale.
   */
  private warnIfSecrets(text: string, sourceLabel: string): void {
    const findings = scanForSecrets(text);
    if (findings.length === 0) {return;}
    const summary = summarizeFindings(findings, sourceLabel);
    this._view?.webview.postMessage({ type: "status", value: summary });
    // Also logged to Diagnostics (not just the transient status toast) —
    // "why did the model see something that looked like a credential" is
    // exactly the kind of thing worth being able to review later.
    this.logDiagnostic("warning", "Secret Scan", summary);
  }

  /**
   * Runs a sub-agent's task as a real multi-turn, tool-using loop (Phase
   * 3.1) — previously this was a single non-tool-using completion, which
   * is why the system prompt's "Multi-Agent" claim didn't match reality.
   * Each sub-agent gets its own message history (not shared with the
   * main conversation) and a tool list scoped to its agentType (see
   * subAgentTools.ts). Tool execution still goes through the same
   * executeTool() as the main agent, so approval gating, secret
   * scanning, and the prompt-injection guard all still apply.
   *
   * When the top-level model requests multiple call_subagent calls in
   * one turn, executeTool's existing Promise.all over that turn's tool
   * calls already runs them concurrently — this method didn't need its
   * own concurrency mechanism, just to stop being a single blocking call.
   *
   * `workingRoot` (Phase 5.5): when set, this agent's file/shell tool
   * calls are scoped to that directory (a git worktree) instead of the
   * real workspace root — see runParallelAgents.
   */
  public async runInternalAgent(agentType: string, task: string, personality?: string, workingRoot?: string): Promise<string> {
    const allTools = [...TOOLS, ...this.mcpManager.getTools()];
    const scopedTools = getScopedTools(agentType, allTools);

    const personalityText = personality ? `\nAdopt this personality trait: ${personality}` : "";
    const isolationNote = workingRoot ? `\nYou are working in an isolated copy of the repo on your own git branch — nothing you do here affects the user's actual files until they choose to merge your branch.` : "";
    const toolsNote = scopedTools.length > 0
      ? `\nYou have access to these tools: ${scopedTools.map((t) => t.name).join(", ")}. Use them as needed, then give your final answer as plain text once done.`
      : `\nYou do not have tool access for this task — answer directly from reasoning.`;
    const subPrompt = `You are a specialized SubAgent: ${agentType}.${personalityText}${isolationNote}
Your task is: ${task}${toolsNote}
Provide a concise, high-quality result.`;

    return this.runAgentLoop(`Sub-agent (${agentType})`, subPrompt, scopedTools, workingRoot);
  }

  /**
   * Runs a repo-defined custom agent (.codepartner/agents/*.md — see
   * customAgents.ts) through the same multi-turn tool-using loop as the
   * built-in sub-agent types. Unlike the four built-ins, tool access
   * comes from the file's own `tools:` frontmatter, not a fixed map, and
   * the file's body IS the system prompt (no persona template wrapping
   * it) — a custom agent should read as exactly what the repo author
   * wrote, not "SubAgent: <name>. <their text>."
   */
  public async runCustomAgent(name: string, task: string, workingRoot?: string): Promise<string> {
    const agents = await this.loadCustomAgents();
    const agent = agents.find((a) => a.name === name);
    if (!agent) {
      const available = agents.length > 0 ? agents.map((a) => a.name).join(", ") : "(none found)";
      return `Error: no custom agent named "${name}" in .codepartner/agents/. Available: ${available}`;
    }

    const allTools = [...TOOLS, ...this.mcpManager.getTools()];
    const scopedTools = resolveAgentTools(agent, allTools);
    const unknown = findUnknownAgentTools(agent, allTools);
    if (unknown.length > 0) {
      this.logDiagnostic("warning", "Custom Agent", `Custom agent "${agent.name}" declares unknown tool(s) in its frontmatter, ignored: ${unknown.join(", ")}`);
    }

    const isolationNote = workingRoot ? `\n\nYou are working in an isolated copy of the repo on your own git branch — nothing you do here affects the user's actual files until they choose to merge your branch.` : "";
    const toolsNote = scopedTools.length > 0
      ? `\n\nYou have access to these tools: ${scopedTools.map((t) => t.name).join(", ")}.`
      : `\n\nYou do not have tool access for this task — answer directly from reasoning.`;
    const systemPrompt = `${agent.instructions}${isolationNote}${toolsNote}\n\nYour current task: ${task}`;

    return this.runAgentLoop(`Custom agent (${agent.name})`, systemPrompt, scopedTools, workingRoot);
  }

  /**
   * The multi-turn, tool-using loop shared by runInternalAgent (built-in
   * sub-agent types) and runCustomAgent (repo-defined .agent.md
   * personas) — extracted so custom agents didn't need a second copy of
   * this logic. `agentLabel` is only used for status/error messages.
   */
  private async runAgentLoop(agentLabel: string, systemPrompt: string, scopedTools: any[], workingRoot?: string): Promise<string> {
    const config = vscode.workspace.getConfiguration("codepartner");
    const apiEndpoint = config.get<string>("apiEndpoint")?.trim() || "";
    const apiKey = await this.getApiKey();
    const modelId = this.selectedModelId || config.get<string>("model")?.trim() || "";
    const providerType = config.get<string>("provider") || "openai";
    const azureApiVersion = config.get<string>("azureApiVersion") || "2024-02-15-preview";

    const scopedToolNames = new Set(scopedTools.map((t) => t.name));
    const subMessages: ProviderMessage[] = [{ role: "system", content: systemPrompt }];
    const MAX_SUBAGENT_ITERATIONS = 6; // Smaller than the main loop's 15 — sub-agent tasks should be narrowly scoped.

    for (let i = 0; i < MAX_SUBAGENT_ITERATIONS; i++) {
      const { url, headers, body } = buildProviderRequest({
        providerType, apiEndpoint, apiKey, modelId, azureApiVersion,
        messages: subMessages,
        tools: scopedTools.length > 0 ? scopedTools : undefined,
        useSystemRole: true,
        maxTokens: 2048,
        stream: false,
      });

      let res;
      try {
        res = await axios.post(url, body, { headers });
      } catch (e: any) {
        return `Error in ${agentLabel}: ${e.response?.data?.error?.message || e.message}`;
      }

      const assistantMsg = extractAssistantMessage(providerType, res.data);
      subMessages.push(assistantMsg);

      const toolCalls = extractToolCalls(providerType, res.data);
      if (toolCalls.length === 0) {
        return (assistantMsg.content as string) || `(${agentLabel} returned no content.)`;
      }

      this.updateStatus(`${agentLabel}${workingRoot ? " (isolated)" : ""}: using ${toolCalls.map((tc) => tc.function.name).join(", ")}...`);

      for (const tc of toolCalls) {
        let toolResult: string;
        if (!scopedToolNames.has(tc.function.name)) {
          // Defense in depth: refuse here too, not just by omitting the
          // tool from the request — a model can still hallucinate a call
          // to a tool it wasn't offered.
          toolResult = `Error: the "${tc.function.name}" tool is not available to ${agentLabel}.`;
        } else {
          const parsed = repairJsonParse(tc.function.arguments);
          if (parsed === null) {
            toolResult = `Error: could not parse arguments for "${tc.function.name}". Retry with valid JSON.`;
          } else {
            toolResult = await this.executeTool(tc.function.name, parsed.value, workingRoot);
          }
        }
        subMessages.push({ role: "tool", content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult), tool_call_id: tc.id, name: tc.function.name });
      }
    }

    return `${agentLabel} reached its iteration limit (${MAX_SUBAGENT_ITERATIONS}) without a final answer. It may have made partial progress via tool calls above.`;
  }

  /** Scans .codepartner/agents/*.md in the workspace root for custom agent definitions (see customAgents.ts). Returns an empty array if the folder doesn't exist or no workspace is open. */
  private async loadCustomAgents(): Promise<CustomAgentDefinition[]> {
    const agents: CustomAgentDefinition[] = [];
    const seen = new Set<string>();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (root) {
      const agentsDir = path.join(root, ".codepartner", "agents");
      if (fs.existsSync(agentsDir)) {
        try {
          const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
          for (const file of files) {
            try {
              const content = fs.readFileSync(path.join(agentsDir, file), "utf8");
              const parsed = parseCustomAgentFile(path.basename(file, ".md"), content);
              if (parsed && !seen.has(parsed.name.toLowerCase())) {
                seen.add(parsed.name.toLowerCase());
                agents.push(parsed);
              }
            } catch (e: any) {
              this.output.appendLine(`[CodePartner] Failed to read custom agent file ${file}: ${e.message}`);
            }
          }
        } catch (e: any) {
          this.output.appendLine(`[CodePartner] Failed to list .codepartner/agents: ${e.message}`);
        }
      }
    }

    // Git-sourced catalog (globalStorage) — workspace agents take precedence
    try {
      for (const a of listCatalogAgents(this.context.globalStorageUri.fsPath)) {
        if (!seen.has(a.name.toLowerCase())) {
          seen.add(a.name.toLowerCase());
          agents.push(a);
        }
      }
    } catch (e: any) {
      this.output.appendLine(`[CodePartner] Catalog agents: ${e.message}`);
    }

    return agents;
  }

  /** Tool implementation for list_custom_agents — a plain text summary, matching how list_skills reports back to the model. */
  private async listCustomAgentsTool(): Promise<string> {
    const agents = await this.loadCustomAgents();
    if (agents.length === 0) {
      return "No custom agents defined. Add .md files to .codepartner/agents/ or set codepartner.pluginCatalogRepo and run sync_plugin_catalog.";
    }
    return agents
      .map((a) => `- ${a.name}: ${a.description}${a.tools.length > 0 ? ` (tools: ${a.tools.join(", ")})` : " (no tool access)"}`)
      .join("\n");
  }

  /**
   * Local async agent: returns job id immediately; runs sub-agent in background.
   */
  private startAsyncAgent(title: string, prompt: string, agentType?: string): string {
    const job = this.asyncAgentQueue.create(title || "Background agent", prompt);
    const type = (agentType || "code_expert").trim();
    this.asyncAgentQueue.markRunning(job.id);
    this.logDiagnostic("info", "AsyncAgent", `Started ${job.id}: ${job.title}`);

    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CodePartner: ${job.title}`,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: "Running…" });
        try {
          if (token.isCancellationRequested) {
            this.asyncAgentQueue.markCancelled(job.id);
            return;
          }
          const result = await this.agentManager.dispatch(type, prompt, this);
          if (token.isCancellationRequested) {
            this.asyncAgentQueue.markCancelled(job.id);
            return;
          }
          this.asyncAgentQueue.markDone(job.id, String(result));
          this.logDiagnostic("info", "AsyncAgent", `Done ${job.id}`);
          vscode.window
            .showInformationMessage(`Background agent finished: ${job.title}`, "Show result")
            .then((pick) => {
              if (pick === "Show result") {
                const j = this.asyncAgentQueue.get(job.id);
                this.output.appendLine(`[AsyncAgent ${job.id}]\n${j?.result || ""}`);
                this.output.show(true);
              }
            });
        } catch (e: any) {
          this.asyncAgentQueue.markError(job.id, e.message || String(e));
          this.logDiagnostic("error", "AsyncAgent", `${job.id}: ${e.message}`);
        }
      }
    );

    return `Started local async agent job **${job.id}** (${job.title}). It runs in the background in this VS Code session only. Use list_async_agents to check status.`;
  }

  /**
   * Phase 5.5: runs 2-8 sub-agents concurrently, each isolated in its own
   * git worktree + branch, so they can safely edit the same files without
   * conflicting with each other or the user's real working tree.
   *
   * Sequencing: worktrees are created SEQUENTIALLY (git worktree add
   * briefly locks the repo's .git directory; doing this concurrently
   * risked lock contention I couldn't fully rule out without a way to
   * stress-test it against a real concurrent-access scenario). Once each
   * worktree exists as an isolated directory, the actual agent runs (the
   * expensive part — LLM calls and tool use) DO run concurrently via
   * Promise.all, which is safe since each agent's filesystem is already
   * fully separate by that point.
   *
   * Each agent's uncommitted work is auto-committed before its worktree
   * is removed — verified against a real repo that this is genuinely
   * lossless (the branch survives worktree removal with all changes
   * intact) before relying on it. Worktrees are cleaned up after each
   * run to avoid leaving scratch directories behind; the branches
   * themselves are NOT deleted and nothing is merged automatically —
   * reviewing and merging is left to the user.
   *
   * Known limitation: cancellation (the "cancel" button) only tracks one
   * in-flight process at a time (this.runningChildProcess), so if
   * multiple isolated agents are running shell commands concurrently,
   * cancel may not stop all of them. Flagged rather than silently
   * accepted — a full fix would need per-agent process tracking.
   */
  private async runParallelAgents(tasks: any): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return "Error: No workspace open.";
    }
    if (!isGitRepo(root)) {
      return "Error: run_parallel_agents requires the workspace to be a git repository (each agent needs its own branch/worktree).";
    }
    if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > 8) {
      return "Error: \"tasks\" must be an array of 2 to 8 {agent_type, task} entries.";
    }

    const runId = Date.now().toString().slice(-6);
    const scratchDir = path.join(os.tmpdir(), "codepartner-worktrees");
    if (!fs.existsSync(scratchDir)) {
      fs.mkdirSync(scratchDir, { recursive: true });
    }

    interface AgentPlan { agentType: string; task: string; personality?: string; branchName: string; worktreePath: string; }
    const plans: AgentPlan[] = tasks.map((t: any, i: number) => {
      const agentType = String(t?.agent_type || "code_expert");
      const task = String(t?.task || "");
      const branchName = `codepartner/${agentType}-${toBranchSafeSegment(task)}-${runId}-${i}`;
      const worktreePath = path.join(scratchDir, `${runId}-${i}`);
      return { agentType, task, personality: t?.personality, branchName, worktreePath };
    });

    // Create worktrees sequentially — see method doc comment.
    const created: AgentPlan[] = [];
    const setupErrors: string[] = [];
    for (const plan of plans) {
      const result = createWorktree(root, plan.worktreePath, plan.branchName);
      if (result.ok) {
        created.push(plan);
      } else {
        setupErrors.push(`${plan.agentType} (${plan.branchName}): failed to create worktree — ${result.error}`);
      }
    }

    if (created.length === 0) {
      return `Error: could not create any worktrees.\n${setupErrors.join("\n")}`;
    }

    this._view?.webview.postMessage({ type: "status", value: `Running ${created.length} agents in parallel, isolated on separate branches...` });

    let baseBranchResult = "";
    try {
      baseBranchResult = cp.execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    } catch {
      // Detached HEAD or another edge case — fall back to HEAD below rather than aborting the whole run.
    }

    const outcomes = await Promise.all(created.map(async (plan) => {
      let finalAnswer: string;
      try {
        finalAnswer = await this.runInternalAgent(plan.agentType, plan.task, plan.personality, plan.worktreePath);
      } catch (e: any) {
        finalAnswer = `Error: ${e.message}`;
      }

      const commitResult = commitAllIfDirty(plan.worktreePath, `codepartner: ${plan.agentType} — ${plan.task.slice(0, 72)}`);
      const diffResult = getBranchDiffStat(root, baseBranchResult || "HEAD", plan.branchName);
      removeWorktree(root, plan.worktreePath, true);

      return {
        plan,
        finalAnswer,
        committed: commitResult.ok ? commitResult.committed : false,
        diffSummary: diffResult.ok ? diffResult.summary : `(could not compute diff: ${diffResult.error})`,
      };
    }));

    const sections = outcomes.map((o, i) =>
      `### Agent ${i + 1}: ${o.plan.agentType} — branch \`${o.plan.branchName}\`\n` +
      `Task: ${o.plan.task}\n\n` +
      `${o.committed ? "Changes committed to this branch." : "No file changes were made."}\n\n` +
      `Files changed:\n${o.diffSummary}\n\n` +
      `Result: ${o.finalAnswer}`
    );

    const displayBaseBranch = baseBranchResult || "HEAD";
    const header = `Ran ${created.length} agents in parallel, each isolated on its own branch (nothing was applied to your working tree or merged — review each branch and merge whichever you want, e.g. \`git diff ${displayBaseBranch}...codepartner/...\` or check one out).`;
    const errorNote = setupErrors.length > 0 ? `\n\n${setupErrors.length} task(s) could not start:\n${setupErrors.join("\n")}` : "";

    return `${header}${errorNote}\n\n${sections.join("\n\n---\n\n")}`;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.output.appendLine("[CodePartner] Resolving webview view...");
    try {
      this._view = webviewView;
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [this.context.extensionUri],
      };
      webviewView.webview.html = this.getHtmlForWebview();

      // Send existing chats to webview on init
      this.sendChatsToWebview();
      this.fetchModels();

      // Send current state to webview
      if (this.messageHistory.length > 1) {
        this._view?.webview.postMessage({ type: "loadMessages", value: this.messageHistory });
        this._view?.webview.postMessage({ type: "plan", value: this.currentPlan });
        this.currentArtifacts.forEach(a => this._view?.webview.postMessage({ type: "artifact", value: a }));
      }
      // Restored separately from the messageHistory check above: a chat
      // can have timeline/revert data worth showing even when this is the
      // very first webview resolve after a restart.
      if (this.timelineEvents.length > 0) {
        this._view?.webview.postMessage({ type: "timeline", value: this.timelineEvents });
      }
      // Agent Debug snapshot (mode, tokens, recent tools, diagnostics)
      this.pushAgentDebug();

      this.output.appendLine("[CodePartner] Webview view resolved successfully.");
    } catch (e: any) {
      this.output.appendLine(`[CodePartner] Error in resolveWebviewView: ${e.message}`);
      this.logDiagnostic("error", "Webview", `Failed to resolve sidebar: ${e.message}`);
      vscode.window.showErrorMessage(`CodePartner Error: ${e.message}`);
    }

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "attachFiles":
          this.handleAttachFiles();
          break;
        case "attachFilesByPath": {
          // Phase: drag-and-drop of a file dragged from VS Code's own
          // Explorer — the webview only got URI strings (text/uri-list),
          // not file content. vscode.Uri.parse(...).fsPath handles the
          // platform-specific parts (Windows drive letters, encoding)
          // correctly, rather than hand-parsing the URI string in JS.
          const uris: string[] = data.value || [];
          const fsPaths = uris
            .map(u => {
              try { return vscode.Uri.parse(u).fsPath; } catch { return null; }
            })
            .filter((p): p is string => !!p);
          this.attachFilesFromPaths(fsPaths);
          break;
        }
        case "prompt":
          this.handlePrompt(data.value, data.attachments);
          break;
        case "cancel":
          this.cancelActiveTask();
          break;
        case "applyDiff":
          this.showDiffView(data.value);
          break;
        case "applyDirect":
          this.applyDirectToEditor(data.value);
          break;
        case "copyCode":
          vscode.env.clipboard.writeText(data.value);
          vscode.window.showInformationMessage("CodePartner: Code copied to clipboard.");
          break;
        case "insertCode":
          this.smartInsertCode(data.value);
          break;
        case "clearChat":
          this.newChat();
          break;
        case "loadChat":
          this.loadChat(data.value);
          break;
        case "deleteChat":
          this.deleteChat(data.value);
          break;
        case "renameChat":
          this.renameChat(data.chatId, data.title);
          break;
        case "getSuggestions":
          this.suggestFiles(data.value);
          break;
        case "changeModel":
          this.selectedModelId = data.value;
          this.context.workspaceState.update("cp-selected-model-id", this.selectedModelId);
          this.output.appendLine(`[CodePartner] Model changed to: ${this.selectedModelId}`);
          break;
        case "changeMode":
          this.executionMode = data.value;
          let promptToUse = FAST_SYSTEM_PROMPT;
          if (this.executionMode === "planning") {
            promptToUse = PLANNING_SYSTEM_PROMPT;
            this.showFirstRunTipIfNeeded("planning", "requires an approved plan (via create_plan) before it will edit or create files — it drafts the plan first and waits for your OK.");
          } else if (this.executionMode === "architect") {
            promptToUse = ARCHITECT_SYSTEM_PROMPT;
            this.showFirstRunTipIfNeeded("architect", "drafts file edits instead of applying them immediately — review the hunks and choose \"Apply Selected Hunks\" or \"Apply All Drafts\" when ready.");
          }
          this.messageHistory[0] = { role: "system", content: promptToUse };
          this.output.appendLine(`[CodePartner] Mode changed to: ${this.executionMode}`);
          this.logDiagnostic("info", "Mode", `Switched to ${this.executionMode}`);
          this.pushAgentDebug();
          break;
        case "revertTurn":
          this.revertTurn(data.value);
          break;
        case "listChats":
          this.sendChatsToWebview();
          break;
        case "openFile":
          this.openFileInEditor(data.value);
          break;
        case "openAbsoluteFile":
          this.openAbsoluteFileInEditor(data.value);
          break;
        case "showDiff":
          this.showDiff(data.value);
          break;
        case "approveChanges":
          this.approveChanges(data.value);
          break;
        case "rejectChanges":
          this.rejectChanges(data.value);
          break;
        case "completeTask":
          if (this.currentPlan[data.value]) {
            this.currentPlan[data.value].done = true;
            this._view?.webview.postMessage({ type: "plan", value: this.currentPlan });
            this.saveCurrentChat();
          }
          break;
        case "sidebarTerminalRun": {
          const cmd = String(data.value || "").trim();
          if (cmd) {
            this._view?.webview.postMessage({ type: "terminalOutput", value: `$ ${cmd}`, kind: "cmd" });
            void this.runInTerminal(cmd, false).then((result) => {
              this._view?.webview.postMessage({
                type: "terminalOutput",
                value: String(result),
                kind: String(result).toLowerCase().includes("error") ? "err" : "out",
              });
            });
          }
          break;
        }
        case "focusTerminal":
          this.focusCodePartnerTerminal();
          break;
        case "listTimeline":
          this._view?.webview.postMessage({ type: "timeline", value: this.timelineEvents });
          break;
        case "clearDiagnostics":
          this.diagnostics = [];
          this.pushAgentDebug();
          break;
        case "requestAgentDebug":
          this.pushAgentDebug();
          break;
        case "openDebugLog":
          this.output.show(true);
          break;
        case "saveSkillFromSuggestion":
          if (this.skillManager) {
            const skillResult = this.skillManager.createSkill(data.name, data.description, data.instructions);
            this._view?.webview.postMessage({ type: "status", value: `✅ ${skillResult}` });
            this._view?.webview.postMessage({ type: "skills", value: this.skillManager.listSkills() });
          }
          break;
        case "applyArchitectDrafts":
          this.applyArchitectDrafts();
          break;
        case "applyArchitectHunks":
          this.applyArchitectHunks(data.value || {});
          break;
        case "revertTimelineAction":
          this.revertTimelineAction(data.chatId, data.timestamp);
          break;
        case "submitFeedback":
          this.handleFeedbackSubmission(data.feedbackType, data.description, data.includeCode);
          break;
      }
    });
  }

  private sendChatsToWebview() {
    const chats = this.context.workspaceState.get<any[]>("cp-chats", []);
    this._view?.webview.postMessage({ type: "chatHistory", value: chats });
  }

  private async handleFeedbackSubmission(type: string, description: string, includeCode: boolean) {
    let codeContent = "";
    if (includeCode) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const doc = editor.document;
        const snippet = doc.getText().substring(0, 3000);
        // This snippet goes into a public GitHub issue, so warn loudly.
        this.warnIfSecrets(snippet, `attached code (${path.basename(doc.fileName)}) — this will be posted to a public GitHub issue`);
        codeContent = `\n\n**Attached Code** (\`${path.basename(doc.fileName)}\`):\n\`\`\`\n${snippet}\n\`\`\``;
      }
    }

    const title = `[${type}] ${description.substring(0, 80)}`;
    const body = `**Type:** ${type}\n\n**Description:**\n${description}${codeContent}\n\n---\n*Submitted via CodePartner extension*`;

    // Use GitHub Issues URL instead of mailto (fixes the Chrome/email bug)
    const issueUrl = `https://github.com/AnandShah10/CodePartner/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=${encodeURIComponent(type.toLowerCase())}`;

    // GitHub Issues URLs have a practical limit of ~8000 chars
    if (issueUrl.length > 8000) {
      // Truncate body for URL but copy full content to clipboard
      const shortBody = `**Type:** ${type}\n\n**Description:**\n${description}\n\n*(Code attachment was too long for URL — pasted from clipboard)*`;
      const shortUrl = `https://github.com/AnandShah10/CodePartner/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(shortBody)}&labels=${encodeURIComponent(type.toLowerCase())}`;

      await vscode.env.clipboard.writeText(body);
      try {
        await vscode.env.openExternal(vscode.Uri.parse(shortUrl));
        this._view?.webview.postMessage({ type: "status", value: "✅ GitHub issue opened! Full content copied to clipboard — paste it in the issue body." });
      } catch {
        this._view?.webview.postMessage({ type: "status", value: "⚠️ Couldn't open browser. Feedback copied to clipboard." });
      }
      return;
    }

    try {
      const success = await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
      if (success) {
        this._view?.webview.postMessage({ type: "status", value: "✅ Feedback prepared in your email client! Please click 'Send'." });
      } else {
        throw new Error("Could not open email client.");
      }
    } catch (e) {
      const fullText = `Title: ${title}\n\n${body}`;
      await vscode.env.clipboard.writeText(fullText);
      this._view?.webview.postMessage({ type: "status", value: "⚠️ Couldn't open mail client. Feedback copied to clipboard instead!" });
      vscode.window.showWarningMessage("Could not open your email client. The feedback has been copied to your clipboard.");
    }
  }

  private saveCurrentChat() {
    const chats = this.context.workspaceState.get<any[]>("cp-chats", []);
    const existingIndex = chats.findIndex(c => c.id === this.currentChatId);

    // Auto-generate title from first user message if not exists
    let title = chats[existingIndex]?.title;
    if (!title) {
      const firstUserMsg = this.messageHistory.find(m => m.role === "user");
      title = firstUserMsg ? (firstUserMsg.content.substring(0, 30) + "...") : "New Chat";
    }

    const updatedChat = {
      id: this.currentChatId,
      title: title,
      messages: this.messageHistory,
      plan: this.currentPlan,
      artifacts: this.currentArtifacts,
      timeline: this.timelineEvents,
      // Phase 2.4: persist the git checkpoint refs for this chat's turns
      // too, so the revert fallback still works after a reload, not just
      // the primary revertContent backups embedded in `timeline` above.
      gitCheckpoints: Array.from(this.turnGitCheckpoints.entries()),
      timestamp: Date.now()
    };

    if (existingIndex > -1) {
      chats[existingIndex] = updatedChat;
    } else {
      chats.unshift(updatedChat);
    }

    this.context.workspaceState.update("cp-chats", chats.slice(0, 50)); // Keep last 50
    this.context.workspaceState.update("cp-last-chat-id", this.currentChatId);
    this.sendChatsToWebview();
  }

  private async loadChat(id: string) {
    // Opening history must not look "busy" — cancel any active turn first.
    // silent+skipDone: do not post `done` (that would flush the prompt queue
    // and could start a new turn while messages are still loading).
    this.cancelActiveTask({ silent: true, skipDone: true });

    if (this.messageHistory.length > 1) {
      this.saveCurrentChat();
    }

    const chats = this.context.workspaceState.get<any[]>("cp-chats", []);
    const chat = chats.find(c => c.id === id);
    if (chat) {
      this.currentChatId = chat.id;
      this.messageHistory = chat.messages;
      this.currentPlan = chat.plan || [];
      this.currentArtifacts = chat.artifacts || [];
      this.timelineEvents = chat.timeline || [];
      this.turnGitCheckpoints = new Map(chat.gitCheckpoints || []);
      // Phase 4.1: token usage counter tracks the active chat, not a
      // running total across whichever chats were opened this session.
      this.sessionTokenUsage = { input: 0, output: 0 };
      this.updateTokenStatusBar();

      // Strip injected context blocks from UI; hide tool/system rows
      const stripForUi = (content: any): any => {
        if (typeof content !== "string") {
          return content;
        }
        let text = content;
        if (text.includes("--- Context ---") && text.includes("User Question:")) {
          text = text.split("User Question:").pop()?.trim() || text;
        }
        // Drop pure status-style noise
        if (/^(Preparing context|Thinking|Refining)\.\.\.?$/i.test(text.trim())) {
          return "";
        }
        return text;
      };

      const uiHistory = this.messageHistory
        .map((m, idx) => {
          const role = m.role;
          const hiddenFromUI =
            idx === 0 ||
            role === "tool" ||
            role === "system" ||
            (role === "assistant" && !m.content && m.tool_calls);
          return {
            ...m,
            content: stripForUi(m.content),
            hiddenFromUI,
          };
        })
        .filter((m) => !m.hiddenFromUI && (m.content || m.role === "user"));

      this._view?.webview.postMessage({ type: "status", value: "" });
      this._view?.webview.postMessage({ type: "loadMessages", value: uiHistory });
      this._view?.webview.postMessage({ type: "plan", value: this.currentPlan });
      this.currentArtifacts.forEach(a => this._view?.webview.postMessage({ type: "artifact", value: a }));
      this._view?.webview.postMessage({ type: "timeline", value: this.timelineEvents });
      this.context.workspaceState.update("cp-last-chat-id", this.currentChatId);

      if (this.skillManager) {
        this._view?.webview.postMessage({ type: "skills", value: this.skillManager.listSkills() });
      }
    }
  };

  private deleteChat(id: string) {
    let chats = this.context.workspaceState.get<any[]>("cp-chats", []);
    chats = chats.filter(c => c.id !== id);
    this.context.workspaceState.update("cp-chats", chats);
    if (this.currentChatId === id) {
      this.newChat();
    } else {
      this.sendChatsToWebview();
    }
  }

  private renameChat(id: string, newTitle: string) {
    const chats = this.context.workspaceState.get<any[]>("cp-chats", []);
    const chat = chats.find(c => c.id === id);
    if (chat) {
      chat.title = newTitle;
      this.context.workspaceState.update("cp-chats", chats);
      this.sendChatsToWebview();
    }
  }

  /** Set when the user hits Stop — checked before every tool and loop iteration so commands don't keep running after cancel. */
  private turnCancelled = false;
  /**
   * Monotonic turn id. Each handlePrompt captures a local id; cancel bumps the
   * global so a *new* prompt cannot clear turnCancelled and let an older loop
   * keep executing tools.
   */
  private activeTurnId = 0;

  /**
   * Stops the current turn's LLM stream and/or any in-flight shell command or test run.
   * @param opts.silent — no UI noise (used when switching chats)
   * @param opts.skipDone — abort without posting `done` (avoids flushing the prompt queue)
   */
  public cancelActiveTask(opts?: { silent?: boolean; skipDone?: boolean }) {
    const silent = !!opts?.silent;
    const skipDone = !!opts?.skipDone || silent;
    const hadWork = !!(this.abortController || this.runningChildProcess);
    this.turnCancelled = true;
    this.activeTurnId++;
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {
        /* ignore */
      }
      this.abortController = undefined;
      if (!silent) {
        this.output.appendLine("[CodePartner] Cancelled by user.");
      }
    }
    if (this.runningChildProcess) {
      try {
        this.runningChildProcess.kill("SIGTERM");
        const child = this.runningChildProcess;
        setTimeout(() => {
          try {
            if (child && !child.killed) {
              child.kill("SIGKILL");
            }
          } catch {
            /* ignore */
          }
        }, 800);
      } catch {
        /* ignore */
      }
      if (!silent) {
        this.output.appendLine("[CodePartner] Killed in-flight command/test run.");
      }
      this.runningChildProcess = undefined;
    }
    if (!silent) {
      this._view?.webview.postMessage({ type: "status", value: hadWork ? "Stopped." : "" });
      if (!skipDone) {
        this._view?.webview.postMessage({ type: "done" });
      }
      if (hadWork) {
        this.logDiagnostic("info", "Cancel", "User stopped the active turn");
      }
    }
  }

  public newChat() {
    // Save current if it has history
    if (this.messageHistory.length > 1) {
      this.saveCurrentChat();
    }

    this.currentChatId = Date.now().toString();
    // Phase 4.1: token usage counter tracks the current chat, not the
    // whole VS Code session — a fresh chat is a fresh task, so a fresh count.
    this.sessionTokenUsage = { input: 0, output: 0 };
    this.updateTokenStatusBar();
    let sysPrompt = FAST_SYSTEM_PROMPT;
    if (this.executionMode === "planning") {
      sysPrompt = PLANNING_SYSTEM_PROMPT;
    } else if (this.executionMode === "architect") {
      sysPrompt = ARCHITECT_SYSTEM_PROMPT;
    }
    this.messageHistory = [{ role: "system", content: sysPrompt }];
    this.currentPlan = [];
    this.currentArtifacts = [];
    this.timelineEvents = [];
    this.turnGitCheckpoints.clear();
    this.architectDrafts.clear();
    this._view?.webview.postMessage({ type: "loadMessages", value: [] });
    this._view?.webview.postMessage({ type: "plan", value: [] });
    this._view?.webview.postMessage({ type: "timeline", value: [] });
    this.context.workspaceState.update("cp-last-chat-id", this.currentChatId);
    this.sendChatsToWebview();

    const welcomeMsg = "👋 **Hello! I'm CodePartner.** How can I help you with your code today?\n\nI can help you:\n- 🚀 **Build features** and write code\n- 🐞 **Debug issues** and fix errors\n- 📁 **Manage files** and workspace structure\n- 🐙 **Automate Git** (diffs, commits, branches)\n- ⚡ **Run commands** in the terminal\n\nWhat are we working on?";
    this._view?.webview.postMessage({ type: "partial", value: md.render(welcomeMsg) });
    this.messageHistory.push({ role: "assistant", content: welcomeMsg });
  }

  private async suggestFiles(data: any) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return;
    }

    const type = typeof data === 'string' ? '@' : (data.type || '@');
    const query = typeof data === 'string' ? data : (data.query || '');
    const q = query.toLowerCase();
    const suggestions: any[] = [];

    try {
      if (type === '/') {
        // Add Skills
        if (this.skillManager) {
          const skills = this.skillManager.listSkills();
          for (const s of skills) {
            if (s.name.toLowerCase().includes(q) || q === "") {
              suggestions.push({
                label: "/" + s.name,
                detail: "Skill: " + s.description,
                type: "skill"
              });
            }
          }
        }
      } else if (type === '@') {
        suggestions.push({ label: "@web", detail: "Search the web", type: "special" });
        suggestions.push({ label: "@workspace", detail: "Entire workspace context", type: "special" });

        // Phase 3.7: filter the cached workspace listing in memory
        // instead of re-running vscode.workspace.findFiles on every
        // keystroke.
        const cachedFiles = await this.getCachedWorkspaceFiles(root);
        const matched = filterCachedFiles(cachedFiles, q, 20);

        for (const f of matched) {
          suggestions.push({
            label: "@" + f.relPath,
            detail: f.fsPath,
            type: "file"
          });
        }

        // Find folders (manual list shared root)
        const dirs = fs.readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules");

        for (const d of dirs) {
          if (d.name.toLowerCase().includes(q)) {
            suggestions.push({
              label: "@" + d.name + "/",
              detail: "Folder",
              type: "folder"
            });
          }
        }
      }

      this._view?.webview.postMessage({ type: "suggestions", value: suggestions });
    } catch {
      // ignore
    }
  }

  /**
   * Returns the workspace file listing used for @-mention suggestions,
   * from cache when fresh (Phase 3.7). A fresh full scan only happens
   * when the cache is empty, stale past MENTION_CACHE_TTL_MS, or was
   * explicitly invalidated by the file-system watcher registered in
   * activate().
   */
  private async getCachedWorkspaceFiles(root: string): Promise<{ relPath: string; fsPath: string }[]> {
    if (isCacheFresh(this.mentionFileCache, MENTION_CACHE_TTL_MS)) {
      return this.mentionFileCache!.files;
    }
    const uris = await vscode.workspace.findFiles(
      "**/*",
      "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}",
      5000
    );
    const files = uris.map((f) => ({ relPath: vscode.workspace.asRelativePath(f), fsPath: f.fsPath }));
    this.mentionFileCache = { files, fetchedAt: Date.now() };
    return files;
  }

  /** Drops the cached @-mention file listing so the next request re-scans. Call on any file create/delete/rename. */
  public invalidateMentionCache(): void {
    this.mentionFileCache = null;
  }

  public refreshModels() {
    this.fetchModels();
  }

  private async fetchModels() {
    const config = vscode.workspace.getConfiguration("codepartner");
    const provider = config.get<string>("provider") || "openai";
    const apiEndpoint = config.get<string>("apiEndpoint")?.trim() || "";
    const apiKey = await this.getApiKey();
    let currentModel = (this.selectedModelId || config.get<string>("model") || "").trim();

    if (provider === "azure") {
      const deployments = config.get<string[]>("azureDeployments") || [];
      this.availableModels = deployments.map(d => ({ id: d, name: d }));

      // If none set, fallback to current or default
      if (this.availableModels.length === 0) {
        this.availableModels = [{ id: currentModel || "gpt-4o", name: currentModel || "gpt-4o" }];
      }

      // Ensure current is in the list
      if (currentModel && !this.availableModels.find(m => m.id === currentModel)) {
        this.availableModels.unshift({ id: currentModel, name: currentModel });
      } else if (!currentModel) {
        currentModel = this.availableModels[0].id;
      }

      this.sendModelsToWebview(currentModel);
      return;
    }

    if (provider === "anthropic") {
      this.availableModels = [
        { id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet" },
        { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet (New)" },
        { id: "claude-3-5-sonnet-20240620", name: "Claude 3.5 Sonnet" },
        { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
        { id: "claude-3-opus-20240229", name: "Claude 3 Opus" },
        { id: "claude-3-sonnet-20240229", name: "Claude 3 Sonnet" },
        { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku" }
      ];
      this.sendModelsToWebview(currentModel || this.availableModels[0].id);
      return;
    }

    if (provider === "google") {
      try {
        if (apiKey) {
          const res = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
          if (res.data && res.data.models) {
            this.availableModels = res.data.models
              .filter((m: any) => m.name.includes('models/') && (m.supportedGenerationMethods?.includes('generateContent')))
              .map((m: any) => ({
                id: m.name.replace('models/', ''),
                name: m.displayName || m.name.replace('models/', '')
              }));
          }
        }
      } catch (e) {
        // Fallback if API key is invalid or request fails
      }
      
      if (this.availableModels.length === 0) {
        this.availableModels = [
          { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
          { id: "gemini-2.0-pro-exp-02-05", name: "Gemini 2.0 Pro Experimental" },
          { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
          { id: "gemini-1.5-pro-latest", name: "Gemini 1.5 Pro" },
          { id: "gemini-1.5-flash-latest", name: "Gemini 1.5 Flash" }
        ];
      }
      this.sendModelsToWebview(currentModel || this.availableModels[0].id);
      return;
    }

    if (provider === "ollama") {
      try {
        const ollamaEndpoint = apiEndpoint || "http://localhost:11434";
        const res = await axios.get(`${ollamaEndpoint}/api/tags`);
        if (res.data && Array.isArray(res.data.models)) {
          this.availableModels = res.data.models.map((m: any) => ({
            id: m.name,
            name: m.name
          }));
        } else {
          this.availableModels = [{ id: "llama3", name: "Llama 3" }];
        }
      } catch {
        this.availableModels = [{ id: "llama3", name: "Llama 3" }];
      }
      this.sendModelsToWebview(currentModel || this.availableModels[0].id);
      return;
    }

    if (!apiEndpoint || !apiKey) {
      this.availableModels = [{ id: currentModel || "gpt-4", name: currentModel || "gpt-4" }];
      this.sendModelsToWebview(currentModel || "gpt-4");
      return;
    }

    try {
      const res = await axios.get(`${apiEndpoint}/models`, {
        headers: { "Authorization": `Bearer ${apiKey}` }
      });
      let models = res.data.data || res.data;
      if (Array.isArray(models)) {
        // Multi-provider compatibility (Ollama, LM Studio, etc.)
        this.availableModels = models.map((m: any) => ({
          id: typeof m === "string" ? m : m.id,
          name: typeof m === "string" ? m : (m.id || m.name)
        }));

        // Filter out obvious non-LLMs like audio/image models, but keep everything else
        const excludeKeywords = ["embedding", "tts", "whisper", "dall-e", "text-to-speech", "audio", "vision-only"];
        const filtered = this.availableModels.filter(m => !excludeKeywords.some(kw => m.id.toLowerCase().includes(kw)));
        if (filtered.length > 0) {
          this.availableModels = filtered;
        }
      } else {
        this.availableModels = [{ id: currentModel || "gpt-4", name: currentModel || "gpt-4" }];
      }
    } catch {
      this.availableModels = [{ id: currentModel || "gpt-4", name: currentModel || "gpt-4" }];
    }

    if (!currentModel && this.availableModels.length > 0) {
      currentModel = this.availableModels[0].id;
    }
    this.sendModelsToWebview(currentModel);
  }

  private sendModelsToWebview(selectedId: string) {
    // Phase 4.5: attach context-window metadata per model, where known,
    // without mutating this.availableModels itself (keeps the stored
    // list simple and provider-shaped).
    const modelsWithMetadata = this.availableModels.map((m) => {
      const meta = getModelMetadata(m.id);
      return meta ? { ...m, contextWindow: meta.contextWindow, contextWindowLabel: formatContextWindow(meta.contextWindow) } : m;
    });
    this._view?.webview.postMessage({
      type: "models",
      value: modelsWithMetadata,
      selected: selectedId
    });
  }

  private async handleAttachFiles() {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
      filters: {
        "All Files": ["*"],
        "Images": ["png", "jpg", "jpeg", "gif", "webp"],
        "Videos": ["mp4", "webm", "ogg"],
        "Documents": ["pdf", "txt", "md"]
      }
    });

    if (!files || files.length === 0) {
      return;
    }

    await this.attachFilesFromPaths(files.map(f => f.fsPath));
  }

  /**
   * Reads files from disk and attaches them, in the shape the webview's
   * existing attachment pipeline already expects. Shared by the file
   * picker (handleAttachFiles) and drag-and-drop of a file dragged from
   * VS Code's own Explorer (where the browser drag event carries a
   * vscode-file:// URI, not real file content the webview can read
   * directly — unlike dragging a file in from the OS file manager, which
   * the webview reads client-side; see the "drop" handler in main.js).
   */
  private async attachFilesFromPaths(fsPaths: string[]): Promise<void> {
    const attached = [];
    for (const fsPath of fsPaths) {
      try {
        const content = await fs.promises.readFile(fsPath);
        const base64 = content.toString("base64");
        const ext = path.extname(fsPath).toLowerCase().substring(1);
        let mimeType = "application/octet-stream";

        if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
          mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;
        } else if (["mp4", "webm", "ogg"].includes(ext)) {
          mimeType = `video/${ext}`;
        } else if (ext === "pdf") {
          mimeType = "application/pdf";
        }

        attached.push({
          name: path.basename(fsPath),
          mimeType,
          data: base64
        });
      } catch (e: any) {
        this.output.appendLine(`[CodePartner] Error reading file: ${e.message}`);
        this.logDiagnostic("warning", "Attach", `Could not read file: ${e.message}`);
      }
    }

    if (attached.length > 0) {
      this._view?.webview.postMessage({ type: "fileAttached", value: attached });
    }
  }

  private async openFileInEditor(relPath: string) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return;
    }
    const fullPath = path.join(root, relPath);
    if (fs.existsSync(fullPath)) {
      const doc = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(doc);
    } else {
      // Try as absolute path
      if (fs.existsSync(relPath)) {
        const doc = await vscode.workspace.openTextDocument(relPath);
        await vscode.window.showTextDocument(doc);
      }
    }
  }

  private async openAbsoluteFileInEditor(absolutePath: string) {
    if (!absolutePath) {
      return;
    }
    try {
      if (fs.existsSync(absolutePath)) {
        const doc = await vscode.workspace.openTextDocument(absolutePath);
        await vscode.window.showTextDocument(doc);
      } else {
        vscode.window.showWarningMessage(`CodePartner: File not found: ${absolutePath}`);
      }
    } catch (e: any) {
      this.logDiagnostic("warning", "Open File", e.message);
      vscode.window.showErrorMessage(`CodePartner: Cannot open file: ${e.message}`);
    }
  }

  private async smartInsertCode(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("CodePartner: No active editor to insert into.");
      return;
    }

    const document = editor.document;
    if (!editor.selection.isEmpty) {
      await editor.edit((eb) => eb.replace(editor.selection, code));
      vscode.window.showInformationMessage("CodePartner: Code replaced selection.");
      return;
    }

    const targetName = this.extractDefinitionName(code);
    if (targetName) {
      const range = this.findDefinitionRange(document, targetName);
      if (range) {
        await editor.edit((eb) => eb.replace(range, code));
        const newPos = range.start;
        editor.selection = new vscode.Selection(newPos, newPos);
        editor.revealRange(new vscode.Range(newPos, newPos), vscode.TextEditorRevealType.InCenter);
        vscode.window.showInformationMessage(`CodePartner: Replaced "${targetName}" in file.`);
        return;
      }
    }

    const cursorLine = editor.selection.active.line;
    const insertPos = new vscode.Position(cursorLine, 0);
    const insertText = code.endsWith("\n") ? code : code + "\n";
    await editor.edit((eb) => eb.insert(insertPos, insertText));
    editor.selection = new vscode.Selection(insertPos, insertPos);
    editor.revealRange(new vscode.Range(insertPos, insertPos), vscode.TextEditorRevealType.InCenter);
    vscode.window.showInformationMessage("CodePartner: Code inserted at current line.");
  }

  private extractDefinitionName(code: string): string | null {
    const patterns = [
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/m,
      /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m,
      /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/m,
      /^\s*(?:public|private|protected|static|async|\s)*\s+(\w+)\s*\(/m,
    ];
    for (const re of patterns) {
      const m = re.exec(code);
      if (m?.[1] && m[1] !== "function" && m[1] !== "class") {
        return m[1];
      }
    }
    return null;
  }

  private findDefinitionRange(document: vscode.TextDocument, name: string): vscode.Range | null {
    const text = document.getText();
    const defRegex = new RegExp(
      `(^|\\n)([ \\t]*)(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\s+${name}|class\\s+${name}|(?:const|let|var)\\s+${name}\\s*=|(?:public|private|protected|static|async|\\s)*\\s*${name}\\s*\\()`
    );
    const match = defRegex.exec(text);
    if (!match) {
      return null;
    }

    const matchStart = match.index + (match[1] === "\n" ? 1 : 0);
    const startPos = document.positionAt(matchStart);

    const braceStart = text.indexOf("{", matchStart);
    if (braceStart === -1) {
      return null;
    }

    let depth = 0;
    let i = braceStart;
    while (i < text.length) {
      if (text[i] === "{") {
        depth++;
      } else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          break;
        }
      }
      i++;
    }

    if (depth !== 0) {
      return null;
    }

    const endIndex = i + 1;
    const trailingNewline = text[endIndex] === "\n" ? endIndex + 1 : endIndex;
    const endPos = document.positionAt(trailingNewline);

    return new vscode.Range(startPos, endPos);
  }

  private async applyDirectToEditor(aiCode: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("CodePartner: No active editor.");
      return;
    }

    const document = editor.document;
    const selection = editor.selection;

    try {
      if (!selection.isEmpty) {
        await editor.edit((editBuilder) => {
          editBuilder.replace(selection, aiCode);
        });
        vscode.window.showInformationMessage("CodePartner: Applied to selection.");
      } else {
        const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
        await editor.edit((editBuilder) => {
          editBuilder.replace(fullRange, aiCode);
        });
        vscode.window.showInformationMessage("✅ CodePartner: File updated with AI changes.");
      }
    } catch (err) {
      vscode.window.showErrorMessage("Failed to apply changes: " + err);
    }
  }

  private async showDiffView(aiCode: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("CodePartner: Open a file to review changes.");
      return;
    }

    const document = editor.document;
    const selection = editor.selection;

    if (!selection.isEmpty) {
      const originalContent = document.getText(selection);
      const originalUri = vscode.Uri.parse(`codepartner-diff:Original_Selection${path.extname(document.fileName)}`);
      const proposedUri = vscode.Uri.parse(`codepartner-diff:Proposed_Selection${path.extname(document.fileName)}`);

      const originalProvider = new SingleContentProvider(originalContent);
      const proposedProvider = new SingleContentProvider(aiCode);

      const disposable1 = vscode.workspace.registerTextDocumentContentProvider("codepartner-diff", originalProvider);
      const disposable2 = vscode.workspace.registerTextDocumentContentProvider("codepartner-diff", proposedProvider);

      await vscode.commands.executeCommand(
        "vscode.diff",
        originalUri,
        proposedUri,
        "CodePartner: Review Changes (Selection) ← Original | AI Proposal →"
      );

      setTimeout(() => {
        disposable1.dispose();
        disposable2.dispose();
      }, 5000);

    } else {
      diffProvider.update(aiCode);
      const originalUri = document.uri;
      const ext = path.extname(document.fileName) || ".txt";
      const proposedUri = vscode.Uri.parse(`${CodePartnerDiffProvider.scheme}:Proposed_Change${ext}`);

      await vscode.commands.executeCommand(
        "vscode.diff",
        originalUri,
        proposedUri,
        `CodePartner: Review Changes ← ${document.fileName} | AI Suggestion →`
      );
    }
    vscode.window.showInformationMessage("Review the diff. Use the buttons in the diff editor to Accept or Revert changes.");
  }

  /**
   * Phase 3.4: injects @-mentioned file content within a shared token
   * budget, instead of the previous unbounded injection (this was the
   * one file-context source with NO cap at all before this change — the
   * others had fixed character caps, this one had none). `budget` is
   * shared with the active-editor/other-tabs context added later in the
   * same turn, so heavy use of one source leaves less room for the rest
   * rather than each source getting its own independent allowance.
   */
  private async getFileMentionsContext(prompt: string, budget: { remaining: number }): Promise<string> {
    const mentionRegex = /@([a-zA-Z0-9_\-./\\]+)/g;
    let match;
    let context = "";
    const seen = new Set<string>();

    while ((match = mentionRegex.exec(prompt)) !== null) {
      const filename = match[1];
      if (["web", "workspace"].includes(filename)) {
        continue;
      }
      if (seen.has(filename)) {
        continue;
      }
      seen.add(filename);

      if (budget.remaining <= 0) {
        this.output.appendLine(`[CodePartner] Skipped @${filename}: context token budget exhausted.`);
        continue;
      }

      try {
        let files = await vscode.workspace.findFiles(`**/${filename}`, "{**/node_modules/**,**/.git/**,**/dist/**}", 1);
        if (!files.length) {
          files = await vscode.workspace.findFiles(`**/*${filename}*`, "{**/node_modules/**,**/dist/**}", 1);
        }
        if (files.length) {
          const doc = await vscode.workspace.openTextDocument(files[0]);
          const rel = vscode.workspace.asRelativePath(files[0]);
          const text = doc.getText();
          this.warnIfSecrets(text, rel);
          this.untrustedContent.track(text);
          const { text: capped, truncated } = truncateToTokenBudget(text, budget.remaining);
          budget.remaining -= estimateTokens(capped);
          const suffix = truncated ? "\n... (truncated to fit context token budget)" : "";
          context += `\n--- File: ${rel} ---\n\`\`\`\n${capped}${suffix}\n\`\`\`\n\n`;
          this.output.appendLine(`[CodePartner] Injected file: ${rel}${truncated ? " (truncated)" : ""}`);
        }
      } catch {
        this.output.appendLine(`[CodePartner] Could not read: ${filename}`);
      }
    }
    return context;
  }

  private async getWebSearchContext(prompt: string): Promise<string> {
    if (!prompt.includes("@web")) {
      return "";
    }
    const queryMatch = prompt.match(/@web\s+(.*)/i);
    const query = queryMatch ? queryMatch[1].trim() : prompt.replace(/@web/gi, "").trim();
    if (!query) {
      return "";
    }

    this._view?.webview.postMessage({ type: "status", value: "🔍 Searching the web..." });

    try {
      this.output.appendLine(`[CodePartner] Web search: ${query}`);
      const res = await axios.get(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
        { timeout: 8000, headers: { "User-Agent": "CodePartner-VSCode/1.0" } }
      );

      const data = res.data as any;
      const parts: string[] = [];
      if (data.AbstractText) {
        parts.push(data.AbstractText);
      }
      if (data.Answer) {
        parts.push(data.Answer);
      }
      if (Array.isArray(data.RelatedTopics)) {
        data.RelatedTopics.slice(0, 4).forEach((t: any) => {
          if (t.Text) {
            parts.push(t.Text);
          }
        });
      }

      if (parts.length > 0) {
        const context = `\n--- Web Search Results for "${query}" ---\n` + parts.map((p, i) => `${i + 1}. ${p}`).join("\n\n") + "\n\n";
        this.untrustedContent.track(context);
        return context;
      }

      const htmlRes = await axios.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
      const html = htmlRes.data as string;
      const snippetRegex = /<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/g;
      const snippets: string[] = [];
      let m;
      while ((m = snippetRegex.exec(html)) !== null && snippets.length < 4) {
        snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      if (snippets.length) {
        const context = `\n--- Web Search Results for "${query}" ---\n` + snippets.map((s, i) => `${i + 1}. ${s}`).join("\n\n") + "\n\n";
        this.untrustedContent.track(context);
        return context;
      }
    } catch (e: any) {
      this.output.appendLine(`[CodePartner] Web search error: ${e.message}`);
    }
    return `\n--- Web Search Failed ---\nNo results for "${query}".\n\n`;
  }

  private async getWorkspaceContext(prompt: string): Promise<string> {
    if (!prompt.includes("@workspace")) {
      return "";
    }
    this._view?.webview.postMessage({ type: "status", value: "📂 Scanning workspace..." });
    try {
      const query = prompt.replace(/@workspace/gi, "").trim();
      if (!query) {
        // Fallback to structure scan if no query
        const files = await vscode.workspace.findFiles("**/*", "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}", 200);
        const paths = files.map((f) => vscode.workspace.asRelativePath(f)).sort();
        return `\n--- Workspace Structure (${paths.length} files) ---\n${paths.join("\n")}\n\n`;
      }

      // Use the new TF-IDF Semantic Search
      const results = await this.semanticSearch.search(query, 4);
      if (results.length === 0) {
        return "\n--- Workspace Search ---\nNo relevant files found.\n\n";
      }

      let context = `\n--- Semantic Workspace Search for "${query}" ---\n`;
      results.forEach((r, i) => {
        this.warnIfSecrets(r.excerpt, r.path);
        context += `\n[${i + 1}] File: ${r.path} (Score: ${r.score.toFixed(2)})\n${r.excerpt}\n`;
      });
      return context + "\n";
    } catch (e: any) {
      this.output.appendLine(`[CodePartner] Workspace context error: ${e.message}`);
      return "";
    }
  }

  /**
   * Compact the conversation context by summarizing old messages.
   */
  private async compactContext() {
    if (this.messageHistory.length < 15) {return;}

    this.output.appendLine("[CodePartner] Compacting context...");
    this.updateStatus("🗜️ Compacting context...");

    try {
      const messagesToSummarize = this.messageHistory.slice(1, -5); // Keep system msg and last 5
      const recentMessages = this.messageHistory.slice(-5);
      const systemMsg = this.messageHistory[0];

      const prompt = `Please summarize the key points of the following conversation history concisely. 
Include key decisions made, files discussed, and major code changes implemented. 
Keep it technical and factual.

CONVERSATION TO SUMMARIZE:
${messagesToSummarize.map(m => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : '[Multimodal content]'}`).join("\n\n")}`;

      // Call LLM for summary (using fast mode parameters)
      const config = vscode.workspace.getConfiguration("codepartner");
      const providerType = config.get<string>("provider") || "openai";
      const apiEndpoint = config.get<string>("apiEndpoint")?.trim() || "";
      const apiKey = await this.getApiKey();
      const modelId = this.selectedModelId || config.get<string>("model")?.trim() || "";
      const azureApiVersion = config.get<string>("azureApiVersion") || "2024-02-15-preview";

      const { url, headers, body } = buildProviderRequest({
        providerType, apiEndpoint, apiKey, modelId, azureApiVersion,
        messages: [{ role: "user", content: prompt }],
        useSystemRole: true,
        maxTokens: 1000,
        temperature: 0.3,
        stream: false,
      });

      const res = await axios.post(url, body, { headers });
      const summary = extractNonStreamedText(providerType, res.data) || "Conversation compacted.";
      
      this.messageHistory = [
        systemMsg,
        { role: "system", content: `--- CONVERSATION SUMMARY ---\n${summary}\n--- END SUMMARY ---` },
        ...recentMessages
      ];

      this.output.appendLine("[CodePartner] Context compacted successfully.");
      this.updateStatus("Context compacted.");
    } catch (e: any) {
      this.output.appendLine(`[CodePartner] Context compaction failed: ${e.message}`);
    }
  }

  /**
   * Handle slash commands (/fix, /explain, etc.)
   */
  private async handleSlashCommand(commandStr: string) {
    const parts = commandStr.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/^\//, "");
    const args = parts.slice(1).join(" ");

    this.output.appendLine(`[CodePartner] Executing slash command: /${cmd}`);

    switch (cmd) {
      case "fix":
        const diagnostics = vscode.languages.getDiagnostics();
        const editor = vscode.window.activeTextEditor;
        let errorContext = "";
        if (editor) {
          const fileErrors = diagnostics
            .filter(([uri]) => uri.toString() === editor.document.uri.toString())
            .flatMap(([, diag]) => diag)
            .filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
            .slice(0, 5);
          
          if (fileErrors.length > 0) {
            errorContext = fileErrors.map(e => `[Line ${e.range.start.line + 1}] ${e.message}`).join("\n");
          }
        }
        const fixPrompt = `Review the active file and fix these diagnostics:\n${errorContext || "Check for syntax errors or common bugs."}\n\n${args}`;
        this.handlePrompt(fixPrompt);
        break;

      case "explain":
        const explainPrompt = `Explain the current code context or selection in detail. ${args}`;
        this.handlePrompt(explainPrompt);
        break;

      case "test":
        const testPrompt = `Write comprehensive unit tests for the current file. Use common testing frameworks for this language. ${args}`;
        this.handlePrompt(testPrompt);
        break;

      case "compact":
        await this.compactContext();
        break;

      case "clear":
        this.newChat();
        break;

      case "help":
      case "?": {
        const helpText =
          "**CodePartner slash commands**\n\n" +
          "| Command | Action |\n|---|---|\n" +
          "| `/fix [note]` | Fix diagnostics in the active file |\n" +
          "| `/explain [note]` | Explain current file or selection |\n" +
          "| `/test [note]` | Generate unit tests for the current file |\n" +
          "| `/compact` | Compact long chat context |\n" +
          "| `/clear` | Start a new chat |\n" +
          "| `/help` | Show this help |\n\n" +
          "Also: **Plan / Fast / Architect** modes, `@file` / `@workspace` / `@web`, drag-and-drop attachments, " +
          "Next Edit Suggestions (`Ctrl+Alt+.`) and Finish Changes (`Ctrl+Alt+Enter`).";
        this._view?.webview.postMessage({ type: "partial", value: helpText });
        this._view?.webview.postMessage({ type: "done" });
        break;
      }

      default:
        this.handlePrompt(commandStr); // Fallback to normal prompt
    }
  }

  private async handlePrompt(prompt: string, attachments: any[] = []) {
    if (!this._view) {
      return;
    }

    // Invalidate any previous in-flight loop, then start a fresh turn id.
    this.activeTurnId++;
    const myTurnId = this.activeTurnId;
    this.turnCancelled = false;

    const isStale = () => this.turnCancelled || myTurnId !== this.activeTurnId;

    // Fresh turn — clear anything tracked for the prompt-injection guard
    // from the previous turn so stale content can't suppress a real check.
    this.untrustedContent.reset();

    // Check for slash command
    if (prompt.startsWith("/")) {
      this.handleSlashCommand(prompt);
      return;
    }

    // Auto-compact when history is getting long — either by message count
    // (the original heuristic) or by an estimated token count (Phase 3.4).
    // Message count alone can miss a handful of very large messages (e.g.
    // large pasted files) that approach context limits well before 40
    // messages accumulate.
    const HISTORY_TOKEN_COMPACTION_THRESHOLD = 20000; // conservative; most current models have well more headroom than this
    const estimatedHistoryTokens = this.messageHistory.reduce(
      (sum, m) => sum + estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")),
      0
    );
    if (this.messageHistory.length > 40 || estimatedHistoryTokens > HISTORY_TOKEN_COMPACTION_THRESHOLD) {
      await this.compactContext();
    }

    this._view.webview.postMessage({ type: "status", value: "Preparing context..." });

    const config = vscode.workspace.getConfiguration("codepartner");
    const apiEndpoint = config.get<string>("apiEndpoint")?.trim() || "";
    const apiKey = await this.getApiKey();
    const modelId = this.selectedModelId || config.get<string>("model")?.trim() || "";
    const providerType = config.get<string>("provider") || "openai";
    const azureApiVersion = config.get<string>("azureApiVersion") || "2024-02-15-preview";
    let maxTokens = config.get<number>("maxTokens") || 4096;
    if (modelId.includes("claude-3-5") || modelId.includes("claude-3-7")) {
      maxTokens = Math.max(maxTokens, 8192);
    }

    const isOllama = providerType === "ollama";
    const needsEndpoint = !["anthropic", "google", "ollama"].includes(providerType);
    const needsKey = !isOllama;

    if ((needsEndpoint && !apiEndpoint) || (needsKey && !apiKey) || !modelId) {
      this._view.webview.postMessage({
        type: "error",
        value: "⚠️ **CodePartner not configured.**\\n\\nOpen **Settings** and set `codepartner.provider`, `codepartner.apiEndpoint`, and `codepartner.model`, then run **CodePartner: Set API Key** from the Command Palette."
      });
      return;
    }

    try {
      let contextHeader = "";
    contextHeader += await this.getWebSearchContext(prompt);
    contextHeader += await this.getWorkspaceContext(prompt);

    // Phase 3.4: token-aware context budget, shared across @file mentions,
    // the active editor's content, and other open tabs — replacing what
    // used to be independent fixed character caps per source (or, for
    // @file mentions, no cap at all).
    const contextBudget = { remaining: vscode.workspace.getConfiguration("codepartner").get<number>("contextTokenBudget") || 6000 };

    contextHeader += await this.getFileMentionsContext(prompt, contextBudget);

    // Phase 3.5: auto-trigger skills whose description keyword-matches
    // this prompt, instead of relying on the model remembering to call
    // list_skills then use_skill. Still counts against the same shared
    // context budget as everything else above.
    if (this.skillManager) {
      const availableSkills = this.skillManager.listSkills();
      const autoSkills = findAutoTriggeredSkills(prompt, availableSkills);
      for (const s of autoSkills) {
        if (contextBudget.remaining <= 0) {break;}
        const skillContent = this.skillManager.useSkill(s.name);
        const { text: cappedSkill, truncated } = truncateToTokenBudget(skillContent, contextBudget.remaining);
        contextBudget.remaining -= estimateTokens(cappedSkill);
        contextHeader += cappedSkill + (truncated ? "\n... (skill truncated to fit context token budget)\n" : "");
        this.output.appendLine(`[CodePartner] Auto-triggered skill: ${s.name}`);
      }
    }

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const document = editor.document;
      const selection = editor.selection;
      const fileName = document.fileName.split(/[/\\]/).pop();
      if (!selection.isEmpty) {
        const code = document.getText(selection);
        this.warnIfSecrets(code, fileName || "selection");
        contextHeader += `\n--- Context ---\nFile: \`${fileName}\`\nSelected Code:\n\`\`\`\n${code}\n\`\`\`\n`;
      } else {
        const text = document.getText();
        this.warnIfSecrets(text, fileName || "active file");
        const { text: capped, truncated } = truncateToTokenBudget(text, contextBudget.remaining);
        contextBudget.remaining -= estimateTokens(capped);
        const suffix = truncated ? "\n... (truncated to fit context token budget)" : "";
        contextHeader += `\n--- Context ---\nFile: \`${fileName}\`\nContent:\n\`\`\`\n${capped}${suffix}\n\`\`\`\n`;
      }
    }

    // Feature 2: Context from other open tabs
    const otherEditors = vscode.window.visibleTextEditors.filter(e => e !== editor).slice(0, 3);
    for (const oe of otherEditors) {
      const doc = oe.document;
      const name = path.basename(doc.fileName);
      const text = doc.getText();
      this.warnIfSecrets(text, name);
      if (contextBudget.remaining <= 0) {
        this.output.appendLine(`[CodePartner] Skipped open tab ${name}: context token budget exhausted.`);
        continue;
      }
      const { text: capped, truncated } = truncateToTokenBudget(text, contextBudget.remaining);
      contextBudget.remaining -= estimateTokens(capped);
      const suffix = truncated ? "\n... (truncated to fit context token budget)" : "";
      contextHeader += `\n--- Context from Open Tab ---\nFile: \`${name}\`\nContent:\n\`\`\`\n${capped}${suffix}\n\`\`\`\n`;
    }

    // Feature 7: Custom Instructions
    if (this.customInstructions) {
      contextHeader = `--- Project-Specific Instructions ---\n${this.customInstructions}\n\n` + contextHeader;
    }

    const finalPromptText = contextHeader.length > 0 ? `${contextHeader}\n\nUser Question:\n${prompt}` : prompt;

    // Construct multimodal content
    const contentParts: any[] = [{ type: "text", text: finalPromptText }];
    for (const att of attachments) {
      if (att.mimeType.startsWith("image/")) {
        contentParts.push({
          type: "image_url",
          image_url: { url: `data:${att.mimeType};base64,${att.data}` }
        });
      } else {
        // For other files, we mention them or send as file parts if model supports
        contentParts.push({
          type: "text",
          text: `\n[Attached File: ${att.name} (${att.mimeType})]\n(Non-image attachments are currently sent as metadata. Ensure your model supports ${att.mimeType} if you expect it to read the content.)`
        });
      }
    }

    this.messageHistory.push({ role: "user", content: attachments.length > 0 ? contentParts : finalPromptText });

    // Clear stats for the new message
    this.fileChangeStats.clear();
    this.modifiedFiles.clear();

    let iteration = 0;
    const maxIterations = 15;
    let useTools = true;
    let useSystemRole = true;
    let toolUsedInThisTurn = false;
    const turnId = Date.now().toString();

    // Phase 2.4: capture a git-backed fallback checkpoint for this turn,
    // in addition to the per-file revertContent backups taken as each
    // edit happens. Only covers tracked files in a git repo; harmless
    // no-op otherwise.
    const checkpointRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (checkpointRoot && isGitRepo(checkpointRoot)) {
      const ref = createGitCheckpoint(checkpointRoot, `codepartner turn ${turnId}`);
      if (ref !== null) {
        this.turnGitCheckpoints.set(turnId, ref);
      }
    }

    while (iteration < maxIterations) {
      iteration++;
      if (isStale()) {
        this.output.appendLine("[CodePartner] Loop aborted — user cancelled or superseded.");
        break;
      }
      this.abortController = new AbortController();
      let fullResponse = "";
      let fullReasoning = "";
      let toolCalls: any[] = [];
      let turnInputTokens: number | undefined;
      let turnOutputTokens: number | undefined;
      this.modifiedFiles.clear();

      // Tool definitions in the flat shape buildProviderRequest expects.
      const toolDefs = useTools ? [...TOOLS, ...this.mcpManager.getTools()] : undefined;

      const { url, headers, body } = buildProviderRequest({
        providerType, apiEndpoint, apiKey, modelId, azureApiVersion,
        messages: this.messageHistory,
        tools: toolDefs,
        useSystemRole,
        maxTokens,
        temperature: 0.4,
        stream: true,
      });

      this.output.appendLine(`[CodePartner] Request: provider=${providerType}, model=${modelId}, url=${url}, tools=${useTools ? (body.tools as any[])?.length || 0 : 'disabled'}, messages=${(body.messages as any[])?.length || 0}`);

      this._view.webview.postMessage({ type: "status", value: iteration === 1 ? "Thinking..." : "Refining..." });

      try {
        const response = await axios.post(url, body, {
          headers,
          responseType: "stream",
          signal: this.abortController.signal
        });
        const parser = createParser({
          onEvent: (event) => {
            if (isStale()) {
              return;
            }
            if (event.data === "[DONE]") {
              return;
            }
            try {
              const parsed = JSON.parse(event.data);

              // Phase 4.1: real token usage for the status bar counter —
              // additive, doesn't affect existing content/tool_call parsing.
              const usage = extractUsageFromStreamEvent(providerType, parsed);
              if (usage) {
                if (usage.inputTokens !== undefined) {turnInputTokens = usage.inputTokens;}
                if (usage.outputTokens !== undefined) {turnOutputTokens = usage.outputTokens;}
              }

              // Anthropic format
              if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                fullResponse += parsed.delta.text;
                this._view?.webview.postMessage({ type: "partial", value: md.render(fullResponse) });
              } else if (parsed.type === "message_start") {
                // message start info
              } else if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
                const index = parsed.index;
                if (!toolCalls[index]) {
                  toolCalls[index] = { id: parsed.content_block.id, type: "function", function: { name: parsed.content_block.name, arguments: "" } };
                }
              } else if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
                const index = parsed.index;
                if (toolCalls[index]) {
                  toolCalls[index].function.arguments += parsed.delta.partial_json;
                }
              }
              // OpenAI / Azure / Google format
              const delta = parsed.choices?.[0]?.delta;
              if (delta) {
                if (delta.reasoning_content || delta.thought) {
                  const reasoning = delta.reasoning_content || delta.thought;
                  fullReasoning += reasoning;
                  this._view?.webview.postMessage({ type: "thought", value: md.render(fullReasoning) });
                }
                if (delta.content) {
                  fullResponse += delta.content;
                  this._view?.webview.postMessage({ type: "partial", value: md.render(fullResponse) });
                }
                if (delta.tool_calls) {
                  delta.tool_calls.forEach((tc: any) => {
                    const index = tc.index;
                    if (!toolCalls[index]) {
                      toolCalls[index] = { id: tc.id, type: "function", function: { name: "", arguments: "" } };
                    }
                    if (tc.id) {
                      toolCalls[index].id = tc.id;
                    }
                    if (tc.function?.name) {
                      toolCalls[index].function.name += tc.function.name;
                    }
                    if (tc.function?.arguments) {
                      toolCalls[index].function.arguments += tc.function.arguments;
                    }
                  });
                }
              }
            } catch {
              // ignore
            }
          }
        });

        await new Promise<void>((resolve, reject) => {
          response.data.on("data", (chunk: Buffer) => parser.feed(chunk.toString("utf8")));
          response.data.on("end", resolve);
          response.data.on("error", reject);
        });

        // Phase 4.1: accumulate real token usage into the session total
        // and refresh the status bar.
        if (turnInputTokens !== undefined) {this.sessionTokenUsage.input += turnInputTokens;}
        if (turnOutputTokens !== undefined) {this.sessionTokenUsage.output += turnOutputTokens;}
        this.updateTokenStatusBar();

        let shouldBreakLoop = false;
        const hadPlanAtTurnStart =
          this.currentPlan.length > 0 ||
          this.currentArtifacts.some((a) => (a.title || "").toLowerCase().includes("plan"));

        if (toolCalls.length > 0) {
          toolCalls = toolCalls.filter(Boolean);
          const assistantMessage = { role: "assistant", content: fullResponse || null, tool_calls: toolCalls };
          this.messageHistory.push(assistantMessage);

          // Feature 5: Parallel Tool Execution
          this.output.appendLine(`[CodePartner] Executing ${toolCalls.length} tools in parallel...`);
          
          const toolPromises = toolCalls.map(async (tc) => {
            const toolStartTime = Date.now();
            let result;
            try {
              if (isStale()) {
                return {
                  id: tc.id,
                  name: tc.function.name,
                  content: "Cancelled: user stopped the turn before this tool ran.",
                };
              }
              const parsed = repairJsonParse(tc.function.arguments);
              if (parsed === null) {
                const errResult = `Error: Could not parse arguments for tool "${tc.function.name}" as JSON, even after attempting basic repair (unterminated string / unbalanced brackets / trailing comma). Raw arguments began with: ${String(tc.function.arguments).substring(0, 200)}\n\nRetry this tool call with strictly valid JSON arguments.`;
                this.output.appendLine(`[CodePartner] Tool call JSON parse failed for ${tc.function.name}, arguments unrecoverable.`);
                this._view?.webview.postMessage({ type: "status", value: `⚠️ Malformed arguments for ${tc.function.name} — asked the model to retry.` });
                return { id: tc.id, name: tc.function.name, content: errResult };
              }
              if (parsed.repaired) {
                this.output.appendLine(`[CodePartner] Repaired malformed JSON arguments for ${tc.function.name}.`);
              }
              const args = parsed.value;
              if (isStale()) {
                return {
                  id: tc.id,
                  name: tc.function.name,
                  content: "Cancelled: user stopped the turn before this tool ran.",
                };
              }
              result = await this.executeTool(tc.function.name, args);
              if (isStale()) {
                return {
                  id: tc.id,
                  name: tc.function.name,
                  content: typeof result === "string"
                    ? `Cancelled after partial run: ${result.slice(0, 200)}`
                    : "Cancelled: user stopped during tool execution.",
                };
              }

              if (tc.function.name === "edit_file" && !result.startsWith("Error")) {
                this.modifiedFiles.add(args.path);
              }

              // Timeline tracking
              let revertContent: string | undefined;
              if (tc.function.name === "edit_file" && !result.startsWith("Error")) {
                revertContent = this.fileBackups.get(args.path);
              } else if (tc.function.name === "create_file" && !result.startsWith("Error")) {
                revertContent = ""; 
              }

              const argsSummary = Object.entries(args).map(([k, v]) => `${k}: ${String(v).substring(0, 40)}`).join(", ");
              const evt = {
                chatId: this.currentChatId,
                tool: tc.function.name,
                argsSummary,
                resultPreview: (typeof result === "string" ? result : JSON.stringify(result)).substring(0, 120),
                success: isToolResultSuccess(result),
                timestamp: toolStartTime,
                duration: Date.now() - toolStartTime,
                revertContent,
                path: args.path,
                turnId
              };
              this.timelineEvents.push(evt);
              this._view?.webview.postMessage({ type: "timelineEvent", value: evt });
              if (!evt.success) {
                this.logDiagnostic(
                  "warning",
                  "Tool",
                  `${evt.tool} failed (${evt.duration}ms): ${String(evt.resultPreview || "").slice(0, 120)}`
                );
              } else {
                this.pushAgentDebug();
              }

              // Ask-before-execution: stop only when first establishing a plan
              // (not when the user has already approved and work is underway)
              if (this.executionMode === "planning" && !hadPlanAtTurnStart) {
                if (tc.function.name === "create_artifact") {
                  const t = (args.title || "").toLowerCase();
                  if (
                    t.includes("implementation_plan") ||
                    t.includes("implementation plan") ||
                    t.includes("plan")
                  ) {
                    shouldBreakLoop = true;
                  }
                }
                if (tc.function.name === "create_plan") {
                  shouldBreakLoop = true;
                }
              }

              // Auto-tick plan tasks when a matching file is edited/created
              if (
                (tc.function.name === "edit_file" || tc.function.name === "create_file") &&
                isToolResultSuccess(result) &&
                args.path &&
                this.currentPlan.length > 0
              ) {
                const fileBase = path.basename(String(args.path)).toLowerCase();
                const filePathLower = String(args.path).toLowerCase();
                let ticked = false;
                for (let i = 0; i < this.currentPlan.length; i++) {
                  const task = this.currentPlan[i];
                  if (task.done) {
                    continue;
                  }
                  const t = task.task.toLowerCase();
                  if (
                    t.includes(fileBase) ||
                    t.includes(filePathLower) ||
                    t.includes(`@${fileBase}`) ||
                    t.includes(`@${filePathLower}`)
                  ) {
                    this.currentPlan[i].done = true;
                    ticked = true;
                  }
                }
                if (ticked) {
                  this._view?.webview.postMessage({ type: "plan", value: this.currentPlan });
                  this.saveCurrentChat();
                }
              }

              return { id: tc.id, name: tc.function.name, content: typeof result === "string" ? result : JSON.stringify(result) };
            } catch (e: any) {
              const errResult = `Error executing tool: ${e.message}`;
              this.logDiagnostic("error", "Tool", `${tc.function.name}: ${e.message}`);
              return { id: tc.id, name: tc.function.name, content: errResult };
            }
          });

          const results = await Promise.all(toolPromises);
          toolUsedInThisTurn = true;

          // Add results to history
          for (const res of results) {
            this.messageHistory.push({
              role: "tool",
              tool_call_id: res.id,
              name: res.name,
              content: res.content,
            });
          }

          if (isStale()) {
            this.output.appendLine("[CodePartner] Stopping after tools — user cancelled or superseded.");
            break;
          }

          // Update UI stats
          if (this.modifiedFiles.size > 0) {
            const stats = Array.from(this.modifiedFiles).map(f => ({
              path: f,
              ...(this.fileChangeStats.get(f) || { added: 0, removed: 0 })
            }));
            this._view?.webview.postMessage({ type: "modifiedFiles", value: stats });
          }

          if (shouldBreakLoop) {
            const waitMsg = "I have created the implementation plan. Please review it in the **Plan** / Artifacts tab and reply with **proceed** to execute.";
            this.messageHistory.push({ role: "assistant", content: waitMsg, turnId });
            this._view?.webview.postMessage({ type: "partial", value: waitMsg });
            this._view?.webview.postMessage({ type: "status", value: "Waiting for user approval..." });
            break;
          }

          continue;
        } else {
          if (fullResponse) {
            this.messageHistory.push({ role: "assistant", content: fullResponse, turnId });
          }
          break;
        }
      } catch (err: any) {
        if (axios.isCancel(err) || err.name === "CanceledError") {
          break;
        }
        const status = err?.response?.status;
        let msg = err?.message || String(err);

        if (err?.response?.data && typeof err.response.data.on === "function") {
          try {
            const dataBuffer = await new Promise<Buffer>((resolve, reject) => {
              const chunks: Buffer[] = [];
              const timeout = setTimeout(() => resolve(Buffer.concat(chunks)), 5000);
              err.response.data.on("data", (c: Buffer) => chunks.push(c));
              err.response.data.on("end", () => { clearTimeout(timeout); resolve(Buffer.concat(chunks)); });
              err.response.data.on("error", () => { clearTimeout(timeout); resolve(Buffer.concat(chunks)); });
            });
            const rawBody = dataBuffer.toString();
            this.output.appendLine(`[CodePartner] Error Response Body: ${rawBody.substring(0, 2000)}`);
            try {
              const errorData = JSON.parse(rawBody);
              msg = errorData?.error?.message || errorData?.message || errorData?.error?.type || msg;
            } catch {
              if (rawBody.length > 0) {msg = rawBody.substring(0, 500);}
            }
          } catch (e) {
            this.output.appendLine(`[CodePartner] Failed to read error stream: ${e}`);
          }
        } else if (err?.response?.data?.error?.message) {
          msg = err.response.data.error.message;
        }

        if (status === 400 || status === 500) {
          // Check if max_tokens is too large
          const maxTokensMatch = msg.match(/at most (\d+) completion tokens/i);
          if (maxTokensMatch && maxTokens > parseInt(maxTokensMatch[1], 10)) {
            maxTokens = parseInt(maxTokensMatch[1], 10);
            this.output.appendLine(`[CodePartner] API indicated max_tokens too high. Adjusting to ${maxTokens} and retrying...`);
            iteration--;
            continue;
          }

          // For transient 500 errors (service unavailable, overloaded), retry with backoff
          const isTransient = status === 500 && /unavailable|overloaded|capacity|temporarily/i.test(msg);
          if (isTransient && iteration <= 3) {
            const delayMs = iteration * 2000;
            this.output.appendLine(`[CodePartner] Transient error: "${msg}". Retrying in ${delayMs / 1000}s...`);
            this._view?.webview.postMessage({ type: "status", value: `⏳ Model busy, retrying in ${delayMs / 1000}s...` });
            await new Promise(r => setTimeout(r, delayMs));
            iteration--;
            continue;
          }

          // Fallback sequence: progressively disable features
          if (useTools) {
            this.output.appendLine(`[CodePartner] ${status} API Error: ${msg}. Retrying without tools as fallback...`);
            this.logDiagnostic("warning", "API", `${status}: ${msg} — retrying without tools`);
            this._view?.webview.postMessage({ type: "status", value: "Retrying without tools..." });
            useTools = false;
            iteration--;
            continue;
          }
          if (useSystemRole) {
            this.output.appendLine(`[CodePartner] ${status} API Error: ${msg}. Retrying without system role as fallback...`);
            useSystemRole = false;
            iteration--;
            continue;
          }
        }

        if (status === 429) {
          // Rate limit - wait and retry
          const retryAfter = parseInt(err?.response?.headers?.['retry-after'] || '5', 10);
          this.output.appendLine(`[CodePartner] Rate limited. Waiting ${retryAfter}s...`);
          this._view?.webview.postMessage({ type: "status", value: `⏳ Rate limited, waiting ${retryAfter}s...` });
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          iteration--;
          continue;
        }

        this._view?.webview.postMessage({ type: "error", value: `❌ **Error${status ? ` (${status})` : ""}:** ${msg}` });
        this.output.appendLine(`[CodePartner] API ERROR: ${status} - ${msg}`);
        this.output.appendLine(`[CodePartner] URL: ${url}`);
        this.output.appendLine(`[CodePartner] Body Preview: ${JSON.stringify(body).substring(0, 1000)}`);
        break;
      } finally {
        this.abortController = undefined;
        this.saveCurrentChat();
      }
    }
    // Proactive Skill Discovery - Only if tools were used THIS turn and not recently suggested
    const recentToolCalls = this.timelineEvents.filter(e => e.chatId === this.currentChatId);
    const toolSummary = recentToolCalls.map(e => e.tool).join(" \u2192 ");

    if (toolUsedInThisTurn && recentToolCalls.length >= 3 && this.suggestedSkillsCount < 3 && !this.suggestedWorkflows.has(toolSummary)) {
      this._view?.webview.postMessage({
        type: "suggestSkill",
        value: { summary: toolSummary, toolCount: recentToolCalls.length }
      });
      this.suggestedWorkflows.add(toolSummary);
      this.suggestedSkillsCount++;
    }
      if (iteration >= maxIterations) {
        this._view?.webview.postMessage({ type: "suggestContinue" });
      }
      this._view?.webview.postMessage({ type: "done", turnId });
    } catch (globalErr: any) {
      this.output.appendLine(`[CodePartner] Fatal Error in handlePrompt: ${globalErr.message || globalErr}`);
      this.logDiagnostic("error", "Agent", `Fatal: ${globalErr.message || globalErr}`);
      this._view?.webview.postMessage({ type: "error", value: `❌ **Error:** ${globalErr.message || globalErr}` });
    }
  }

  /**
   * `rootOverride` (Phase 5.5): when a tool call is being executed on
   * behalf of an isolated parallel sub-agent (see runParallelAgents),
   * this points at that agent's git worktree directory instead of the
   * real workspace root, so its file/shell tools operate there. Omitted
   * for the main agent and regular (non-isolated) sub-agents, which
   * behave exactly as before.
   */
  private async executeTool(name: string, args: any, rootOverride?: string): Promise<any> {
    if (this.executionMode === "planning") {
      const hasPlan = this.currentPlan.length > 0 || this.currentArtifacts.some(a => a.title.toLowerCase().includes("plan"));
      if (!hasPlan && (name === "edit_file" || name === "create_file")) {
        this.logDiagnostic(
          "warning",
          "Planning",
          `Blocked ${name} until implementation plan + create_plan exist`
        );
        return `Error: You are in PLANNING MODE but have not created a plan yet. Create the implementation plan artifact (create_artifact, title including "implementation_plan") and the structured task checklist (create_plan) before making code changes.`;
      }
    }

    // Phase 1: permission gate. Architect mode already only drafts file
    // edits (applied later via an explicit "Apply" action), which is
    // itself the safe default, so the approval popup would be redundant
    // for file-write calls made while in that mode.
    const gatedCategory = GATED_TOOLS[name];
    if (gatedCategory) {
      const skipBecauseArchitectDraft = gatedCategory === "file-write" && this.executionMode === "architect";
      if (!skipBecauseArchitectDraft) {
        const decision = await this.requestApprovalIfNeeded(name, gatedCategory, args, rootOverride);
        if (decision !== "allow") {
          return `Denied: the user did not approve this ${gatedCategory.replace("-", " ")} action (${name}). Explain what you intended to do and why, then ask how they'd like to proceed.`;
        }
      }
    }

    switch (name) {
      case "run_command":
        return this.runCommand(args.command, rootOverride);
      case "run_in_terminal":
        return this.runInTerminal(args.command, !!args.background, rootOverride);
      case "send_terminal_input":
        return this.sendTerminalInput(String(args.text ?? ""), args.press_enter !== false);
      case "list_dir":
        return this.listDir(args.path, rootOverride);
      case "read_file":
        return this.readFile(args.path, rootOverride);
      case "edit_file":
        return this.editFile(args.path, args.search, args.replace, rootOverride);
      case "create_file":
        return this.createFile(args.path, args.content, rootOverride);
      case "web_search":
        return this.getWebSearchContext(`@web ${args.query}`);
      case "call_subagent":
        return this.agentManager.dispatch(args.agent_type, args.task, this, args.personality);
      case "list_custom_agents":
        return this.listCustomAgentsTool();
      case "call_custom_agent":
        return this.runCustomAgent(args.name, args.task, rootOverride);
      case "run_parallel_agents":
        return this.runParallelAgents(args.tasks);
      case "run_async_agent":
        return this.startAsyncAgent(args.title || "", args.prompt, args.agent_type);
      case "list_async_agents":
        return this.asyncAgentQueue.formatList();
      case "sync_plugin_catalog": {
        const config = vscode.workspace.getConfiguration("codepartner");
        const repo = config.get<string>("pluginCatalogRepo") || "";
        const branch = config.get<string>("pluginCatalogBranch") || "";
        const msg = syncPluginCatalog(
          this.context.globalStorageUri.fsPath,
          repo,
          branch || undefined
        );
        this.logDiagnostic(msg.includes("fail") || msg.startsWith("Error") ? "error" : "info", "PluginCatalog", msg);
        return msg;
      }
      case "list_ci_runs": {
        const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
          return "No workspace open.";
        }
        return listCiRuns(root, args.limit);
      }
      case "trigger_ci_workflow": {
        const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
          return "No workspace open.";
        }
        return triggerWorkflow(root, args.workflow, args.ref);
      }
      case "write_ci_workflow": {
        const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
          return "No workspace open.";
        }
        return ensureGithubWorkflow(root, args.name, args.content || "");
      }
      case "create_artifact":
        if (this.artifactRegistry) {
          const art = this.artifactRegistry.create(args.title, args.content, args.type);
          this.currentArtifacts.push(art);
          this._view?.webview.postMessage({ type: "artifact", value: art });
          return `Artifact created: ${art.title} (ID: ${art.id})`;
        }
        return "Error: Workspace not open, cannot create artifact.";
      case "create_plan":
        return this.createPlan(args.tasks);
      case "update_plan_task":
        return this.updatePlanTask(args.index, args.done);
      case "browser_control":
        if (!this.browserManager) {
          return "Error: Workspace not open, browser control disabled.";
        }
        const result = await this.browserManager.execute(args.action, args.url, args.selector, args.text);
        if (args.action === "screenshot" && !result.startsWith("Error")) {
          try {
            const art = JSON.parse(result);
            this.currentArtifacts.push(art);
            this._view?.webview.postMessage({ type: "artifact", value: art });
            return `Screenshot artifact created: ${art.title}`;
          } catch { return result; }
        }
        return result;
      case "create_skill":
        return this.skillManager?.createSkill(args.name, args.description, args.instructions) || "No workspace open.";
      case "use_skill":
        return this.skillManager?.useSkill(args.name) || "No workspace open.";
      case "list_skills":
        const skills = this.skillManager?.listSkills() || [];
        this._view?.webview.postMessage({ type: "skills", value: skills });
        return `Found ${skills.length} skills. Sent to UI.`;
      case "grep_search":
        return this.grepSearch(args.pattern, args.path, args.include, rootOverride);
      case "scan_licenses":
        return this.scanLicenses(args.path, args.include_missing, args.max_files, rootOverride);
      case "scan_code_references":
        return this.scanCodeReferences(args.code, args.path, args.min_score, args.max_files, rootOverride);
      case "run_tests":
        return this.runTests(args.command, rootOverride);
      case "index_docs":
        return this.indexDocs(args.url, args.title);
      case "query_knowledge":
        return this.queryKnowledge(args.query);
      case "generate_commit_message":
        const diff = await this.gitManager.getDiff();
        return `Draft a commit message for these changes:\n\n${diff}`;
      case "get_git_status":
        return this.gitManager.getStatus();
      case "create_git_branch":
        return this.gitManager.createBranch(args.name);
      case "stage_git_changes":
        return this.gitManager.stageAll();
      case "commit_git_changes":
        return this.gitManager.commit(args.message);
      case "create_pull_request":
        return this.gitManager.createPullRequest(args.title, args.body, args.base);
      default:
        // Handle MCP tools
        if (this.mcpManager.isMCPTool(name)) {
          return this.mcpManager.callTool(name, args);
        }
        return `Error: Tool not found: ${name}`;
    }
  }

  /**
   * Phase 1 permission gate. Decides whether a shell/file/git tool call
   * needs a visible confirmation, then shows it if so.
   *
   * The prompt-injection check (untrustedContent.matches) runs regardless
   * of policy and regardless of the session allow-list — see
   * promptInjectionGuard.ts for why.
   */
  private async requestApprovalIfNeeded(name: string, category: GatedCategory, args: any, rootOverride?: string): Promise<"allow" | "deny"> {
    const config = vscode.workspace.getConfiguration("codepartner");
    const policy = (config.get<string>("approvalPolicy") as ApprovalPolicy) || "always-ask";

    const argsText = JSON.stringify(args ?? {});
    const flaggedByInjectionGuard = this.untrustedContent.matches(argsText);

    let needsPrompt = flaggedByInjectionGuard || needsApprovalForPolicy(category, policy);

    if (!flaggedByInjectionGuard && needsPrompt) {
      // Session allow-list shortcuts only apply to non-flagged calls.
      if (category === "shell" && matchesApprovedPrefix(args?.command || "", this.approvedCommandPrefixes)) {
        needsPrompt = false;
      } else if (category === "file-write" && this.sessionAutoApprove.fileWrite) {
        needsPrompt = false;
      } else if (category === "git-write" && this.sessionAutoApprove.gitWrite) {
        needsPrompt = false;
      }
    }

    if (!needsPrompt) {
      return "allow";
    }

    const description = describeToolCall(name, args);
    const warningPrefix = flaggedByInjectionGuard
      ? "⚠️ This content closely matches text pulled from a web search, indexed docs, or an @-mentioned file. Confirming even though your autonomy setting would normally skip this — review carefully before allowing.\n\n"
      : "";
    // Phase 5.5: make it unmistakable when this action is happening in an
    // isolated worktree, not the user's real working tree.
    const isolationNote = rootOverride
      ? `📦 Isolated parallel agent run (${rootOverride}) — this does NOT touch your actual working tree.\n\n`
      : "";

    this.output.appendLine(`[CodePartner] Requesting approval for ${name}${flaggedByInjectionGuard ? " (flagged: possible prompt injection)" : ""}${rootOverride ? " (isolated worktree)" : ""}: ${description}`);

    const buttons = flaggedByInjectionGuard ? ["Allow", "Deny"] : ["Allow", "Always Allow This Session", "Deny"];
    const choice = await vscode.window.showWarningMessage(
      `${isolationNote}${warningPrefix}CodePartner wants to: ${description}`,
      { modal: true },
      ...buttons
    );

    if (choice === "Always Allow This Session") {
      if (category === "shell") {
        this.approvedCommandPrefixes.add(commandPrefix(args?.command || ""));
      } else if (category === "file-write") {
        this.sessionAutoApprove.fileWrite = true;
      } else if (category === "git-write") {
        this.sessionAutoApprove.gitWrite = true;
      }
      return "allow";
    }
    if (choice === "Allow") {
      return "allow";
    }
    this.output.appendLine(`[CodePartner] Denied: ${name}`);
    return "deny";
  }

  /**
   * Runs a shell command via child_process.spawn, streaming stdout/stderr
   * and resolving on the "close" event — replaces the old temp-file
   * polling hack, which resolved as soon as the output file had ANY bytes
   * (so a slow-but-fine command could return truncated output) and had no
   * way to actually stop a hung process, just stop waiting on it.
   */
  private async runCommand(command: string, rootOverride?: string): Promise<string> {
    const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return "No workspace open.";
    }

    const TIMEOUT_MS = 120000; // 2 minutes — real builds/tests can be slow; this isn't a snappy-command assumption.

    this._view?.webview.postMessage({ type: "status", value: `Running: ${command}` });
    this.output.appendLine(`[CodePartner] $ ${command}`);

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const child = cp.spawn(command, { cwd: root, shell: true, env: process.env });
      this.runningChildProcess = child;

      const finish = (message: string) => {
        if (settled) {return;}
        settled = true;
        clearTimeout(timeoutHandle);
        if (this.runningChildProcess === child) {
          this.runningChildProcess = undefined;
        }
        resolve(message);
      };

      const timeoutHandle = setTimeout(() => {
        child.kill();
        const combined = formatOutput(stdout, stderr);
        this.warnIfSecrets(combined, `terminal output (${command})`);
        finish(`Command timed out after ${TIMEOUT_MS / 1000}s and was killed. Partial output:\n${combined || "(none)"}`);
      }, TIMEOUT_MS);

      child.stdout?.on("data", (d) => { stdout += d.toString(); });
      child.stderr?.on("data", (d) => { stderr += d.toString(); });

      child.on("error", (err) => {
        finish(`Error running command: ${err.message}`);
      });

      child.on("close", (code) => {
        const combined = formatOutput(stdout, stderr);
        this.warnIfSecrets(combined, `terminal output (${command})`);
        finish(`Exit code: ${code}\n${combined || "(no output)"}`);
      });
    });
  }

  /**
   * Runs a command in a VISIBLE VS Code terminal (unlike runCommand,
   * which is deliberately hidden — spawned, not shown), for anything the
   * user should watch or might want to type into: dev servers, watchers,
   * interactive CLIs.
   *
   * VERIFICATION NOTE: this uses VS Code's Terminal Shell Integration API
   * (Terminal.shellIntegration, TerminalShellExecution.read(),
   * onDidChangeTerminalShellIntegration, onDidEndTerminalShellExecution),
   * which stabilized in VS Code 1.93 — this extension's minimum version
   * was bumped accordingly (see package.json). I could not compile this
   * against real @vscode/types or run it against a live VS Code instance
   * in this sandbox (no network access to install the updated typings),
   * so the exact shape of these APIs is written from documented,
   * remembered behavior, not verified. Every call into it is
   * feature-detected and wrapped so a wrong assumption here degrades to
   * the plain sendText fallback (command still runs visibly, just
   * without captured output/exit code) rather than throwing — please
   * test this specifically against a real VS Code 1.93+ before relying
   * on captured output/exit codes from it.
   */
  private async runInTerminal(command: string, background: boolean, rootOverride?: string): Promise<string> {
    const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return "No workspace open.";
    }

    if (!this.visibleTerminal || this.visibleTerminal.exitStatus !== undefined) {
      this.visibleTerminal = vscode.window.createTerminal({ name: "CodePartner", cwd: root });
    }
    const terminal = this.visibleTerminal;
    terminal.show(true); // reveal the terminal without stealing focus from wherever the user currently is

    if (background) {
      // Long-running/never-exiting process (dev server, watcher) — start
      // it and return immediately. Don't bother with shell integration
      // here; there's no "finish" to wait for.
      terminal.sendText(command, true);
      return `Started "${command}" in the visible CodePartner terminal (background — not waiting for it to finish). Check the terminal panel to see its output.`;
    }

    let shellIntegration: vscode.TerminalShellIntegration | undefined;
    try {
      shellIntegration = terminal.shellIntegration;
      if (!shellIntegration) {
        // Shell integration activates asynchronously after terminal
        // creation, even for a shell that supports it — give it a short
        // window before falling back, so we don't give up on a shell
        // that would have worked half a second later.
        shellIntegration = await new Promise<vscode.TerminalShellIntegration | undefined>((resolve) => {
          const timer = setTimeout(() => { disposable.dispose(); resolve(undefined); }, 3000);
          const disposable = vscode.window.onDidChangeTerminalShellIntegration((e) => {
            if (e.terminal === terminal) {
              clearTimeout(timer);
              disposable.dispose();
              resolve(e.shellIntegration);
            }
          });
        });
      }
    } catch (e: any) {
      this.output.appendLine(`[CodePartner] Shell integration check failed, falling back to sendText: ${e.message}`);
      shellIntegration = undefined;
    }

    if (!shellIntegration) {
      terminal.sendText(command, true);
      return `Command sent to the visible CodePartner terminal: ${command}\nThis shell doesn't support VS Code's shell integration (or it hasn't activated yet), so output and exit code can't be captured automatically — check the terminal panel to see the result.`;
    }

    const TIMEOUT_MS = 120000;
    try {
      const execution = shellIntegration.executeCommand(command);
      let output = "";
      const readPromise = (async () => {
        for await (const chunk of execution.read()) {
          output += chunk;
        }
      })();

      const timedOut = await Promise.race([
        readPromise.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), TIMEOUT_MS)),
      ]);

      const cleaned = stripAnsiCodes(output).trim();
      this.warnIfSecrets(cleaned, `terminal output (${command})`);

      if (timedOut) {
        return `Command is still running after ${TIMEOUT_MS / 1000}s in the visible CodePartner terminal (not killed — check the terminal panel). Output so far:\n${cleaned || "(none yet)"}`;
      }

      const exitCode = await new Promise<number | undefined>((resolve) => {
        const timer = setTimeout(() => { disposable.dispose(); resolve(undefined); }, 5000);
        const disposable = vscode.window.onDidEndTerminalShellExecution((e) => {
          if (e.execution === execution) {
            clearTimeout(timer);
            disposable.dispose();
            resolve(e.exitCode);
          }
        });
      });

      return `Exit code: ${exitCode ?? "(unknown)"}\n${cleaned || "(no output)"}`;
    } catch (e: any) {
      this.output.appendLine(`[CodePartner] run_in_terminal shell-integration path failed, falling back to sendText: ${e.message}`);
      terminal.sendText(command, true);
      return `Command sent to the visible CodePartner terminal: ${command}\nCould not capture output automatically (${e.message}) — check the terminal panel to see the result.`;
    }
  }

  /**
   * Send text to the visible CodePartner terminal for interactive use
   * (answer prompts, type into a running REPL/server CLI).
   */
  private sendTerminalInput(text: string, pressEnter: boolean): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!this.visibleTerminal || this.visibleTerminal.exitStatus !== undefined) {
      if (!root) {
        return "No workspace open and no CodePartner terminal is open. Use run_in_terminal first.";
      }
      this.visibleTerminal = vscode.window.createTerminal({ name: "CodePartner", cwd: root });
    }
    const terminal = this.visibleTerminal;
    terminal.show(false);
    terminal.sendText(text, pressEnter);
    return `Sent to CodePartner terminal${pressEnter ? " (with Enter)" : " (no Enter)"}: ${JSON.stringify(text)}`;
  }

  /** Focus/reveal the CodePartner terminal panel. */
  public focusCodePartnerTerminal(): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!this.visibleTerminal || this.visibleTerminal.exitStatus !== undefined) {
      this.visibleTerminal = vscode.window.createTerminal({
        name: "CodePartner",
        cwd: root,
      });
    }
    this.visibleTerminal.show(true);
  }

  private listDir(relPath: string, rootOverride?: string): string {
    const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return "No workspace open.";
    }
    const fullPath = path.join(root, relPath);
    try {
      if (!fs.existsSync(fullPath)) {
        return `Path does not exist: ${relPath}`;
      }
      const stats = fs.statSync(fullPath);
      if (!stats.isDirectory()) {
        return `Not a directory: ${relPath}`;
      }
      const files = fs.readdirSync(fullPath);
      return files.join("\n");
    } catch (e: any) {
      return `Error listing directory: ${e.message}`;
    }
  }

  private readFile(relPath: string, rootOverride?: string): string {
    const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return "No workspace open.";
    }
    const fullPath = path.join(root, relPath);
    try {
      if (!fs.existsSync(fullPath)) {
        return `File does not exist: ${relPath}`;
      }
      const content = fs.readFileSync(fullPath, "utf8");
      this.warnIfSecrets(content, relPath);
      return content;
    } catch (e: any) {
      return `Error reading file: ${e.message}`;
    }
  }

  private async editFile(relPath: string, search: string, replace: string, rootOverride?: string): Promise<string> {
    const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return "Error: No workspace folder open."; }
    const fullPath = path.join(root, relPath);
    try {
      if (!fs.existsSync(fullPath)) {
        return `Error: File does not exist: ${relPath}. Use create_file for new files.`;
      }

      const originalContent = this.executionMode === "architect" && !rootOverride && this.architectDrafts.has(relPath)
        ? this.architectDrafts.get(relPath)!
        : fs.readFileSync(fullPath, "utf8");

      if (!this.fileBackups.has(relPath)) {
        this.fileBackups.set(relPath, fs.readFileSync(fullPath, "utf8"));
      }

      const editResult = applyEdit(originalContent, search, replace);
      if (!editResult.ok) {
        if (editResult.error === NOT_FOUND) {
          return `Error: Could not find the search text in ${relPath}. Please read_file first and use the exact text.`;
        }
        // Ambiguous match (multiple occurrences) — refuse rather than
        // silently editing the wrong one. See editUtils.ts.
        return `Error: ${editResult.error}`;
      }
      const { content: newContent, added, removed } = editResult;
      this.fileChangeStats.set(relPath, { added, removed });

      // See createFile()'s comment: Architect Mode drafting is a
      // main-workspace concept, bypassed for isolated sub-agents.
      if (this.executionMode === "architect" && !rootOverride) {
        this.architectDrafts.set(relPath, newContent);
        this.sendArchitectDrafts();
        return `[Architect Draft] File ${relPath} updated. +${added} -${removed} lines. Pending Apply.`;
      }

      fs.writeFileSync(fullPath, newContent, "utf8");
      return `File ${relPath} updated successfully. +${added} -${removed} lines.`;
    } catch (e: any) {
      return `Error editing file: ${e.message}`;
    }
  }

  /**
   * Non-code deliverables (plans, walkthroughs, design notes) belong in the
   * Artifacts panel — not as random files in the repo root.
   */
  private shouldRouteToArtifact(relPath: string): boolean {
    const base = path.basename(relPath).toLowerCase();
    const dir = path.dirname(relPath).replace(/\\/g, "/").toLowerCase();
    const ext = path.extname(base);
    const nameHints =
      /^(implementation[_-]?plan|plan|walkthrough|design|spec|architecture|readme|notes|changelog|todo|tasks)(\.|$)/i.test(
        base
      ) ||
      base.includes("walkthrough") ||
      base.includes("implementation_plan") ||
      base.includes("implementation-plan");
    const docExt = [".md", ".mdx", ".txt", ".rst"].includes(ext);
    const inDocDir =
      dir === "." ||
      dir === "" ||
      dir.startsWith("docs") ||
      dir.startsWith("artifacts") ||
      dir.includes(".codepartner");
    // Never reroute source code or intentional project README/changelog
    const codeExt = [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
      ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php",
      ".json", ".yml", ".yaml", ".toml", ".css", ".scss", ".html", ".vue", ".svelte",
    ].includes(ext);
    if (codeExt) {
      return false;
    }
    if (base === "readme.md" || base === "changelog.md" || base === "license" || base === "license.md") {
      return false;
    }
    // Only route clearly non-code agent deliverables (plans/walkthroughs), not every docs/*.md
    return nameHints && (docExt || inDocDir);
  }

  private async createFile(relPath: string, content: string, rootOverride?: string): Promise<string> {
    const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return "Error: No workspace folder open."; }

    // Route plan/walkthrough/docs to Artifacts instead of polluting the workspace
    if (!rootOverride && this.shouldRouteToArtifact(relPath) && this.artifactRegistry) {
      const title =
        path.basename(relPath, path.extname(relPath)).replace(/[_-]/g, " ") ||
        "Document";
      const type =
        path.extname(relPath).toLowerCase() === ".md" ||
        path.extname(relPath).toLowerCase() === ".mdx"
          ? "markdown"
          : "text";
      const art = this.artifactRegistry.create(title, content, type);
      this.currentArtifacts.push(art);
      this._view?.webview.postMessage({ type: "artifact", value: art });
      this.saveCurrentChat();
      this.logDiagnostic(
        "info",
        "Artifacts",
        `Routed non-code file "${relPath}" → artifact "${art.title}"`
      );
      return `Saved as artifact "${art.title}" (ID: ${art.id}) instead of writing ${relPath} to disk — open the Artifacts tab. Use create_artifact for plans/walkthroughs intentionally.`;
    }

    const fullPath = path.join(root, relPath);
    try {
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      if (fs.existsSync(fullPath) && !this.fileBackups.has(relPath)) {
        this.fileBackups.set(relPath, fs.readFileSync(fullPath, "utf8"));
      }

      const lines = content.split(/\r?\n/).filter(l => l.trim() !== "").length;
      this.fileChangeStats.set(relPath, { added: lines, removed: 0 });

      // Architect Mode's "draft, don't apply" behavior is a main-workspace
      // concept — an isolated parallel sub-agent (rootOverride set) writes
      // directly into its own worktree instead; review happens at the
      // branch/diff level (see runParallelAgents), not per-file drafts.
      if (this.executionMode === "architect" && !rootOverride) {
        this.architectDrafts.set(relPath, content);
        this.sendArchitectDrafts();
        return `[Architect Draft] File ${relPath} created. ${lines} lines. Pending Apply.`;
      }

      fs.writeFileSync(fullPath, content, "utf8");
      return `File ${relPath} created successfully. ${lines} lines.`;
    } catch (e: any) {
      return `Error creating file: ${e.message}`;
    }
  }

  private grepSearch(pattern: string, searchPath?: string, include?: string, rootOverride?: string): string {
    const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return "No workspace open."; }
    const targetPath = searchPath ? path.join(root, searchPath) : root;
    try {
      const isWin = process.platform === "win32";
      let command: string;
      if (isWin) {
        const searchDir = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
        const fileFilter = include || "*.*";
        command = `findstr /S /N /I /C:"${pattern.replace(/"/g, '\\"')}" "${searchDir}\\${fileFilter}"`;
      } else {
        const includeFlag = include ? `--include="${include}"` : "";
        command = `grep -rnI ${includeFlag} "${pattern}" "${targetPath}"`;
      }
      const output = cp.execSync(command, { cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
      const lines = output.split("\n").filter(l => l.trim()).slice(0, 50);
      return lines.length > 0 ? lines.join("\n") : "No matches found.";
    } catch (e: any) {
      if (e.status === 1) { return "No matches found."; }
      return `Search error: ${e.message}`;
    }
  }

  /**
   * Scan source files for SPDX / common license headers.
   */
  private scanLicenses(
    relPath?: string,
    includeMissing?: boolean,
    maxFiles?: number,
    rootOverride?: string
  ): string {
    const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return "No workspace open.";
    }
    const startDir = relPath ? path.join(root, relPath) : root;
    if (!fs.existsSync(startDir)) {
      return `Path not found: ${relPath || "."}`;
    }
    const limit = typeof maxFiles === "number" && maxFiles > 0 ? Math.min(maxFiles, 200) : 80;
    const exts = new Set([
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
      ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php",
      ".md", ".txt",
    ]);
    const skipDirs = new Set(["node_modules", ".git", "dist", "out", "build", ".next", "coverage"]);
    const collected: { path: string; text: string }[] = [];

    const walk = (dir: string) => {
      if (collected.length >= limit) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (collected.length >= limit) {
          break;
        }
        if (ent.name.startsWith(".") && ent.name !== ".gitignore") {
          if (ent.isDirectory()) {
            continue;
          }
        }
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (skipDirs.has(ent.name)) {
            continue;
          }
          walk(full);
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          const base = ent.name.toLowerCase();
          const interesting =
            exts.has(ext) ||
            base === "license" ||
            base === "licence" ||
            base === "copying" ||
            base.startsWith("license.");
          if (!interesting) {
            continue;
          }
          try {
            const stat = fs.statSync(full);
            if (stat.size > 512_000) {
              continue;
            }
            const text = fs.readFileSync(full, "utf8");
            collected.push({
              path: path.relative(root, full).replace(/\\/g, "/"),
              text,
            });
          } catch {
            /* skip unreadable */
          }
        }
      }
    };

    if (fs.statSync(startDir).isFile()) {
      try {
        collected.push({
          path: path.relative(root, startDir).replace(/\\/g, "/"),
          text: fs.readFileSync(startDir, "utf8"),
        });
      } catch (e: any) {
        return `Read error: ${e.message}`;
      }
    } else {
      walk(startDir);
    }

    const findings = scanLicenseTexts(collected, !!includeMissing);
    return summarizeLicenseFindings(findings);
  }

  /**
   * Copilot-style attribution: find similar code regions in the workspace.
   */
  private scanCodeReferences(
    code: string,
    relPath?: string,
    minScore?: number,
    maxFiles?: number,
    rootOverride?: string
  ): string {
    const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return "No workspace open.";
    }
    if (!code || String(code).trim().length < 8) {
      return "Error: provide a longer code snippet to scan for references.";
    }
    const startDir = relPath ? path.join(root, relPath) : root;
    if (!fs.existsSync(startDir)) {
      return `Path not found: ${relPath || "."}`;
    }
    const limit = typeof maxFiles === "number" && maxFiles > 0 ? Math.min(maxFiles, 250) : 100;
    const threshold = typeof minScore === "number" ? minScore : 0.35;
    const exts = new Set([
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
      ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php",
    ]);
    const skipDirs = new Set(["node_modules", ".git", "dist", "out", "build", ".next", "coverage"]);
    const collected: { path: string; text: string }[] = [];

    const walk = (dir: string) => {
      if (collected.length >= limit) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (collected.length >= limit) {
          break;
        }
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (skipDirs.has(ent.name) || ent.name.startsWith(".")) {
            continue;
          }
          walk(full);
        } else if (ent.isFile() && exts.has(path.extname(ent.name).toLowerCase())) {
          try {
            const stat = fs.statSync(full);
            if (stat.size > 400_000) {
              continue;
            }
            collected.push({
              path: path.relative(root, full).replace(/\\/g, "/"),
              text: fs.readFileSync(full, "utf8"),
            });
          } catch {
            /* skip */
          }
        }
      }
    };

    if (fs.statSync(startDir).isFile()) {
      try {
        collected.push({
          path: path.relative(root, startDir).replace(/\\/g, "/"),
          text: fs.readFileSync(startDir, "utf8"),
        });
      } catch (e: any) {
        return `Read error: ${e.message}`;
      }
    } else {
      walk(startDir);
    }

    const hits = rankCodeReferences(String(code), collected, threshold, 12);
    return formatCodeReferenceReport(hits);
  }

  /**
   * Auto-detects and runs the test suite via child_process.spawn (async,
   * streamed), instead of the old cp.execSync call which blocked the
   * entire extension host for up to 60s on every test run. Supports
   * cancellation via the "cancel" webview message (see runningChildProcess).
   */
  private async runTests(customCommand?: string, rootOverride?: string): Promise<string> {
    const root = rootOverride || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return "No workspace open."; }
    let command = customCommand;
    if (!command) {
      const pkgPath = path.join(root, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
            command = "npm test";
          } else if (pkg.devDependencies?.jest || pkg.dependencies?.jest) {
            command = "npx jest --no-coverage";
          } else if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) {
            command = "npx vitest run";
          } else if (pkg.devDependencies?.mocha || pkg.dependencies?.mocha) {
            command = "npx mocha";
          }
        } catch { /* ignore */ }
      }
      if (!command) {
        if (fs.existsSync(path.join(root, "pytest.ini")) || fs.existsSync(path.join(root, "setup.py"))) {
          command = "python -m pytest --tb=short -q";
        } else if (fs.existsSync(path.join(root, "manage.py"))) {
          command = "python manage.py test";
        }
      }
      if (!command) {
        return "Could not auto-detect test runner. Please provide a command (e.g., 'npm test', 'pytest').";
      }
    }

    const TIMEOUT_MS = 300000; // 5 minutes — test suites commonly run longer than a typical shell command.
    const testCommand = command;
    this._view?.webview.postMessage({ type: "status", value: `Running tests: ${testCommand}` });
    this.output.appendLine(`[CodePartner] $ ${testCommand} (tests)`);

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let lastStreamedLength = 0;

      const child = cp.spawn(testCommand, { cwd: root, shell: true, env: process.env });
      this.runningChildProcess = child;

      const streamPartial = () => {
        const total = stdout.length + stderr.length;
        if (total - lastStreamedLength >= 200) {
          lastStreamedLength = total;
          this._view?.webview.postMessage({ type: "status", value: `Running tests: ${testCommand} (${total}b output so far)` });
        }
      };

      const finish = (message: string) => {
        if (settled) {return;}
        settled = true;
        clearTimeout(timeoutHandle);
        if (this.runningChildProcess === child) {
          this.runningChildProcess = undefined;
        }
        resolve(message);
      };

      const timeoutHandle = setTimeout(() => {
        child.kill();
        const combined = formatOutput(stdout, stderr);
        this.warnIfSecrets(combined, `test output (${testCommand})`);
        finish(`Tests timed out after ${TIMEOUT_MS / 1000}s and were killed. Partial output:\n${combined || "(none)"}`);
      }, TIMEOUT_MS);

      child.stdout?.on("data", (d) => { stdout += d.toString(); streamPartial(); });
      child.stderr?.on("data", (d) => { stderr += d.toString(); streamPartial(); });

      child.on("error", (err) => {
        finish(`Error running tests: ${err.message}`);
      });

      child.on("close", (code) => {
        const combined = formatOutput(stdout, stderr);
        this.warnIfSecrets(combined, `test output (${testCommand})`);
        finish(code === 0 ? `Tests passed.\n\n${combined}` : `Tests failed (exit code ${code}).\n\n${combined}`);
      });
    });
  }

  private async indexDocs(url: string, title: string): Promise<string> {
    const knowledgeDir = path.join(os.homedir(), ".codepartner", "knowledge");
    if (!fs.existsSync(knowledgeDir)) {
      fs.mkdirSync(knowledgeDir, { recursive: true });
    }

    this._view?.webview.postMessage({ type: "status", value: `📖 Indexing docs: ${url}...` });

    try {
      if (!this.browserManager) {
        return "Error: Browser manager not initialized.";
      }
      const result = await this.browserManager.execute("navigate", url);
      if (result.startsWith("Error")) {
        return result;
      }

      const content = result.split("Content Preview: ")[1] || "";
      const fileName = `${title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.md`;
      const filePath = path.join(knowledgeDir, fileName);

      fs.writeFileSync(filePath, `# ${title}\nSource: ${url}\n\n${content}`, "utf8");
      return `Successfully indexed "${title}" to ${fileName}. You can now use query_knowledge to search it.`;
    } catch (e: any) {
      return `Error indexing docs: ${e.message}`;
    }
  }

  private queryKnowledge(query: string): string {
    const knowledgeDir = path.join(os.homedir(), ".codepartner", "knowledge");
    if (!fs.existsSync(knowledgeDir) || fs.readdirSync(knowledgeDir).length === 0) {
      return "No documentation indexed yet. Use index_docs first.";
    }

    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
    const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith(".md"));
    let results = "";

    for (const file of files) {
      const content = fs.readFileSync(path.join(knowledgeDir, file), "utf8");
      const lines = content.split("\n");
      const matches = lines.filter(line =>
        keywords.some(kw => line.toLowerCase().includes(kw))
      );

      if (matches.length > 0) {
        results += `\n--- From: ${file} ---\n${matches.slice(0, 5).join("\n")}\n`;
      }
    }

    if (results) {
      this.warnIfSecrets(results, "indexed docs");
      this.untrustedContent.track(results);
    }
    return results || `No relevant information found for "${query}" in indexed documentation.`;
  }

  private async showDiff(relPath: string) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return;
    }
    const fullPath = path.join(root, relPath);
    const original = this.fileBackups.get(relPath) || "";

    // Register temporary original content in diff provider
    const originalUri = vscode.Uri.parse(`${CodePartnerDiffProvider.scheme}:Original/${path.basename(relPath)}`);
    diffProvider.update(original);

    // Create new content provider for current file (or just use file:// uri)
    const currentUri = vscode.Uri.file(fullPath);

    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      currentUri,
      `${relPath} (Original ↔ Agentic Change)`
    );
  }

  private async approveChanges(relPath: string) {
    // Keep the changes, clear the backup
    this.fileBackups.delete(relPath);
    vscode.window.showInformationMessage(`Approved changes in ${relPath}.`);
  }

  private async rejectChanges(relPath: string) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root || !this.fileBackups.has(relPath)) {
      return;
    }
    const fullPath = path.join(root, relPath);
    const original = this.fileBackups.get(relPath)!;

    fs.writeFileSync(fullPath, original, "utf8");
    this.fileBackups.delete(relPath);

    // Remove from modified files list
    this.modifiedFiles.delete(relPath);
    this.fileChangeStats.delete(relPath);

    const stats = Array.from(this.modifiedFiles).map(f => ({
      path: f,
      ...(this.fileChangeStats.get(f) || { added: 0, removed: 0 })
    }));
    this._view?.webview.postMessage({ type: "modifiedFiles", value: stats });

    vscode.window.showWarningMessage(`Reverted changes in ${relPath}.`);
  }

  /** Reads the on-disk content a draft is being compared against, or "" for a file that doesn't exist yet (Phase 3.2). */
  private getArchitectOriginalContent(root: string, relPath: string): string {
    const fullPath = path.join(root, relPath);
    if (fs.existsSync(fullPath)) {
      try {
        return fs.readFileSync(fullPath, "utf8");
      } catch {
        return "";
      }
    }
    return "";
  }

  /**
   * Phase 3.3: structured plan creation, replacing the dead extractPlan()
   * regex parser (it was defined but never actually called anywhere in
   * the codebase — the Plan panel's UI was fully built and working, but
   * nothing ever populated real data into it for a fresh conversation).
   * The model now sets the checklist directly as JSON instead of the
   * fragile approach of asking it to write `[x]`/`[ ]` markdown into an
   * artifact and hoping a regex parses it correctly.
   */
  private createPlan(tasks: any): string {
    const result = buildPlanFromTasks(tasks);
    if ("error" in result) {
      return `Error: ${result.error}`;
    }
    this.currentPlan = result.plan;
    this._view?.webview.postMessage({ type: "plan", value: this.currentPlan });
    this.saveCurrentChat();
    return `Plan created with ${this.currentPlan.length} task(s).`;
  }

  private updatePlanTask(index: number, done: boolean): string {
    const validation = validatePlanIndex(this.currentPlan, index);
    if (!validation.ok) {
      return `Error: ${validation.error}`;
    }
    this.currentPlan[index].done = !!done;
    this._view?.webview.postMessage({ type: "plan", value: this.currentPlan });
    this.saveCurrentChat();
    return `Task ${index} ("${this.currentPlan[index].task}") marked as ${done ? "done" : "not done"}.`;
  }

  private sendArchitectDrafts() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const drafts = Array.from(this.architectDrafts.entries()).map(([relPath, content]) => {
      const original = root ? this.getArchitectOriginalContent(root, relPath) : "";
      // Phase 3.2: per-hunk diff review data, alongside the existing
      // whole-file summary so "Apply All Drafts" still works unchanged.
      const dl = diffLines(original, content);
      const hunks = groupIntoHunks(dl, 3);
      return {
        path: relPath,
        lines: content.split(/\r?\n/).length,
        hunks: hunks.map((h) => ({ id: h.id, oldStart: h.oldStart, newStart: h.newStart, lines: h.lines })),
      };
    });
    this._view?.webview.postMessage({ type: "architectDrafts", value: drafts });
  }

  private applyArchitectDrafts() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return; }

    let count = 0;
    for (const [relPath, content] of this.architectDrafts.entries()) {
      const fullPath = path.join(root, relPath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      fs.writeFileSync(fullPath, content, "utf8");
      this.modifiedFiles.add(relPath);
      count++;
    }

    this.architectDrafts.clear();
    this.sendArchitectDrafts();

    const stats = Array.from(this.modifiedFiles).map(f => ({
      path: f,
      ...(this.fileChangeStats.get(f) || { added: 0, removed: 0 })
    }));
    this._view?.webview.postMessage({ type: "modifiedFiles", value: stats });
    this._view?.webview.postMessage({ type: "status", value: `🏗️ Architect Mode: Applied ${count} drafted files.` });
    vscode.window.showInformationMessage(`Applied ${count} drafted files.`);
  }

  /**
   * Applies only the accepted hunks per file (Phase 3.2), instead of the
   * whole draft. `selections` maps relPath -> array of accepted hunk ids
   * (from the webview's per-hunk checkboxes). A file with zero accepted
   * hunks is left untouched on disk but still cleared from the draft
   * queue, matching a full per-file reject.
   */
  private applyArchitectHunks(selections: Record<string, string[]>) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return; }

    let filesChanged = 0;
    for (const [relPath, content] of this.architectDrafts.entries()) {
      const acceptedIds = new Set(selections[relPath] || []);
      const original = this.getArchitectOriginalContent(root, relPath);
      const dl = diffLines(original, content);
      const hunks = groupIntoHunks(dl, 3);
      const finalContent = applyAcceptedHunks(dl, hunks, acceptedIds);

      if (finalContent !== original) {
        const fullPath = path.join(root, relPath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        fs.writeFileSync(fullPath, finalContent, "utf8");
        this.modifiedFiles.add(relPath);
        filesChanged++;
      }
    }

    this.architectDrafts.clear();
    this.sendArchitectDrafts();

    const stats = Array.from(this.modifiedFiles).map(f => ({
      path: f,
      ...(this.fileChangeStats.get(f) || { added: 0, removed: 0 })
    }));
    this._view?.webview.postMessage({ type: "modifiedFiles", value: stats });
    this._view?.webview.postMessage({ type: "status", value: `🏗️ Architect Mode: Applied selected hunks in ${filesChanged} file(s).` });
    vscode.window.showInformationMessage(`Applied selected hunks in ${filesChanged} file(s).`);
  }

  private revertTimelineAction(chatId: string, timestamp: number) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {return;}

    const event = this.timelineEvents.find(e => e.chatId === chatId && e.timestamp === timestamp);
    if (!event || !event.path) {
      vscode.window.showErrorMessage("Cannot revert this action: No backup found.");
      return;
    }

    // Phase 2.4: fall back to the git checkpoint for this turn when the
    // primary revertContent backup isn't available (e.g. an older chat
    // saved before this field existed).
    const gitRef = this.turnGitCheckpoints.get(event.turnId);
    if (event.revertContent === undefined && gitRef === undefined) {
      vscode.window.showErrorMessage("Cannot revert this action: No backup found.");
      return;
    }

    const fullPath = path.join(root, event.path);
    try {
      if (event.revertContent !== undefined) {
        if (event.revertContent === "") {
          // Was created by agent, so reverting means deleting it
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
        } else {
          // Was edited, revert to previous content
          fs.writeFileSync(fullPath, event.revertContent, "utf8");
        }
      } else if (gitRef !== undefined) {
        const ok = restoreFileFromCheckpoint(root, gitRef, event.path);
        if (!ok) {
          throw new Error("no revertContent backup, and the git checkpoint fallback couldn't restore this file (it may not have existed at checkpoint time)");
        }
      }

      // Update UI
      event.reverted = true;
      this._view?.webview.postMessage({ type: "timeline", value: this.timelineEvents });
      vscode.window.showInformationMessage(`Reverted changes to ${event.path}.`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to revert: ${e.message}`);
    }
  }

  private revertTurn(turnId: string) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {return;}

    const gitRef = this.turnGitCheckpoints.get(turnId);
    const eventsToRevert = this.timelineEvents.filter(e =>
      e.turnId === turnId && !e.reverted && (e.revertContent !== undefined || gitRef !== undefined)
    );
    eventsToRevert.sort((a, b) => b.timestamp - a.timestamp);

    let revertedCount = 0;
    for (const event of eventsToRevert) {
      if (!event.path) {continue;}
      const fullPath = path.join(root, event.path);
      try {
        if (event.revertContent !== undefined) {
          if (event.revertContent === "") {
            if (fs.existsSync(fullPath)) {
              fs.unlinkSync(fullPath);
            }
          } else {
            fs.writeFileSync(fullPath, event.revertContent, "utf8");
          }
        } else if (gitRef !== undefined) {
          const ok = restoreFileFromCheckpoint(root, gitRef, event.path);
          if (!ok) {
            throw new Error("git checkpoint fallback couldn't restore this file");
          }
        }
        event.reverted = true;
        revertedCount++;
      } catch (e: any) {
        this.output.appendLine(`[CodePartner] Failed to revert ${event.path}: ${e.message}`);
      }
    }

    if (revertedCount > 0) {
      this._view?.webview.postMessage({ type: "timeline", value: this.timelineEvents });
      vscode.window.showInformationMessage(`Reverted ${revertedCount} file changes from that turn.`);
    } else {
      vscode.window.showInformationMessage("No file changes to revert for this turn.");
    }
  }

  private getHtmlForWebview() {
    const webview = this._view!.webview;
    // Cache-bust so media/main.js|css updates apply after F5 without stale webview cache
    const bust = `v=${Date.now()}`;
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")).with({ query: bust });
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css")).with({ query: bust });

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; img-src ${webview.cspSource} data:;" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>CodePartner</title>
</head>
<body>
  <div id="app">

    <div id="header">
      <div id="header-title">
        <svg class="logo" viewBox="0 0 16 16"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2a5 5 0 1 1 0 10A5 5 0 0 1 8 3zm-.5 2v3.25l2.6 1.5.5-.87L8.5 7.5V5h-1z"/></svg>
        <span id="brand-name">CodePartner</span>
        <select id="model-selector" title="Select Model">
          <option value="">Loading models...</option>
        </select>
      </div>
      <div id="header-actions">
        <button id="history-btn" class="icon-btn header-action-btn" title="Saved Chats" aria-label="Saved Chats">
          <svg viewBox="0 0 16 16"><path d="M14.5 13.5V12a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v1.5a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5zM2 3V2a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1h1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3h1zm11 0V2H3v1h10zM2 12h12V4H2v8z"/></svg>
        </button>
        <button id="feedback-btn" class="icon-btn header-action-btn" title="Send Feedback / Report Bug" aria-label="Feedback">
          <svg viewBox="0 0 16 16"><path d="M1 2a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5l-3 3V2z"/></svg>
        </button>
        <button id="new-chat-btn" class="icon-btn header-action-btn" title="New Chat" aria-label="New Chat">
          <svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3 8H9v2H7V9H5V7h2V5h2v2h2v2z"/></svg>
        </button>
        <div class="header-more-wrap">
          <button id="header-more-btn" class="icon-btn" title="More" aria-label="More actions" aria-expanded="false" aria-haspopup="true">
            <svg viewBox="0 0 16 16"><path d="M3 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>
          </button>
          <div id="header-more-menu" class="header-more-menu hidden" role="menu">
            <button type="button" class="header-more-item" data-action="history" role="menuitem">Saved chats</button>
            <button type="button" class="header-more-item" data-action="feedback" role="menuitem">Feedback</button>
            <button type="button" class="header-more-item" data-action="new-chat" role="menuitem">New chat</button>
          </div>
        </div>
      </div>
    </div>

    <div id="tab-bar">
      <button class="tab-btn active" data-tab="chat" title="Chat">
        <svg viewBox="0 0 16 16"><path d="M14.5 2h-13a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5H3.1l2.5 2.5a.5.5 0 0 0 .707 0l2.5-2.5h5.693a.5.5 0 0 0 .5-.5v-10a.5.5 0 0 0-.5-.5zM14 12H8.5a.5.5 0 0 0-.354.146L6 14.293 3.854 12.146A.5.5 0 0 0 3.5 12H2V3h12v9z"/></svg>
      </button>
      <button class="tab-btn" data-tab="timeline" title="Timeline">
        <svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2a5 5 0 1 1 0 10A5 5 0 0 1 8 3zm-.5 2v3.25l2.6 1.5.5-.87L8.5 7.5V5h-1z"/></svg>
      </button>
      <button class="tab-btn" data-tab="artifacts" title="Artifacts">
        <svg viewBox="0 0 16 16"><path d="M4 1.75V14h8V4.75L9.25 1.75H4zM3.25 0h6a.75.75 0 0 1 .53.22l3.5 3.5a.75.75 0 0 1 .22.53v10.5A1.25 1.25 0 0 1 12.25 16H3.75A1.25 1.25 0 0 1 2.5 14.75V1.25C2.5.56 3.06 0 3.75 0h-.5z"/></svg>
      </button>
      <button class="tab-btn" data-tab="plan" title="Plan">
        <svg viewBox="0 0 16 16"><path d="M3.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-9zM5 5h6v1H5V5zm0 2.5h6v1H5v-1zm0 2.5h4v1H5v-1z"/></svg>
      </button>
      <button class="tab-btn" data-tab="skills" title="Skills">
        <svg viewBox="0 0 16 16"><path d="M11 2a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3h6z"/></svg>
      </button>
      <button class="tab-btn" data-tab="diagnostics" title="Agent Debug">
        <svg viewBox="0 0 16 16"><path d="M8 1a.75.75 0 0 1 .75.75v.5a5.5 5.5 0 0 1 4.702 4.702h.5a.75.75 0 0 1 0 1.5h-.5a5.5 5.5 0 0 1-4.702 4.702v.5a.75.75 0 0 1-1.5 0v-.5A5.5 5.5 0 0 1 2.548 8.452h-.5a.75.75 0 0 1 0-1.5h.5A5.5 5.5 0 0 1 7.25 2.25v-.5A.75.75 0 0 1 8 1zM8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0v-1.5h-1.5a.75.75 0 0 1 0-1.5h1.5v-1.5A.75.75 0 0 1 8 6z"/></svg>
      </button>
      <button class="tab-btn" data-tab="terminal" title="Terminal">
        <svg viewBox="0 0 16 16"><path d="M0 2.75A.75.75 0 0 1 .75 2h14.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 2.75zM0 13.25a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75zM2.5 6.5l3 2-3 2V6.5zm4.5 3.25h5a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1 0-1.5z"/></svg>
      </button>
    </div>

    <div id="main-content">
      <div id="history-panel" class="hidden">
        <div class="panel-header">
          <span>Saved Chats</span>
          <button id="close-history" class="icon-btn" title="Close"><svg viewBox="0 0 16 16"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/></svg></button>
        </div>
        <div id="chat-list"></div>
      </div>

      <div id="tab-chat" class="tab-content active">
        <div id="chat-container">
          <div id="chat-history"></div>
          <div id="status-bar"><div id="status-text"></div></div>
          <div id="input-outer">
            <div id="architect-drafts" class="hidden">
              <div class="drafts-header">Architect Drafts Pending</div>
              <div id="drafts-list"></div>
              <div class="drafts-actions">
                <button id="apply-hunks-btn" class="secondary">Apply Selected Hunks</button>
                <button id="apply-drafts-btn">Apply All Drafts</button>
              </div>
            </div>
            <div id="suggestion-list" class="hidden"></div>
            <div id="attachment-chips" class="hidden"></div>
            <div id="input-container">
              <div id="prompt-overlay"></div>
              <textarea id="prompt-input" rows="1" placeholder="Ask anything..."></textarea>
              <div class="input-footer">
                <div class="tag-hints">
                  <button id="attach-btn" class="icon-btn" title="Attach Files">
                    <svg viewBox="0 0 16 16"><path d="M4.496 6.675l.66 6.623C5.336 14.445 6.297 16 7.494 16h4c1.197 0 2.158-1.445 2.338-2.552l.66-6.623a.75.75 0 0 0-1.492-.15l-.66 6.623a.853.853 0 0 1-.845.727H7.494a.853.853 0 0 1-.845-.727l-.66-6.623a.75.75 0 0 0-1.492-.15zM2.75 3.5h10.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5z"/></svg>
                  </button>
                  <div class="mode-toggle">
                    <button id="mode-fast" class="mode-btn active" title="Fast Mode (no planning)">
                      <svg viewBox="0 0 16 16"><path d="M11.251.068a.999.999 0 0 1 .697 1.39L9.07 6h4.18a1 1 0 0 1 .75 1.664l-7.25 8.25a1 1 0 0 1-1.697-1.054L7.93 10H3.75a1 1 0 0 1-.75-1.664l7.25-8.25a1 1 0 0 1 1.001-.018z"/></svg>
                    </button>
                    <button id="mode-plan" class="mode-btn" title="Planning Mode (creates implementation plan)">
                      <svg viewBox="0 0 16 16"><path d="M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2h6v1H5V5zm0 2h6v1H5V7zm0 2h4v1H5V9z"/></svg>
                    </button>
                    <button id="mode-architect" class="mode-btn" title="Architect Mode (drafts changes without applying)">
                      <svg viewBox="0 0 16 16"><path d="M8 1L2 5v6l6 4 6-4V5L8 1zm0 2.2l4 2.6-4 2.6L4 5.8l4-2.6zM3 10.3l4.5 3v-3.8L3 6.9v3.4zm9.5 0V6.9l-4.5 2.6v3.8l4.5-3z"/></svg>
                    </button>
                  </div>
                </div>
                <button id="send-btn" title="Send (Enter)">
                  <svg viewBox="0 0 16 16"><path d="M1.724 1.053a.5.5 0 0 0-.714.545l1.403 4.85a.5.5 0 0 0 .397.354l5.69.953c.268.053.268.437 0 .49l-5.69.953a.5.5 0 0 0-.397.354l-1.403 4.85a.5.5 0 0 0 .714.545l13-6.5a.5.5 0 0 0 0-.894l-13-6.5Z"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div id="tab-artifacts" class="tab-content">
        <div id="artifact-list">
          <div class="empty-state">No artifacts created yet.</div>
        </div>
      </div>

      <div id="tab-skills" class="tab-content">
        <div id="skill-list">
          <div class="empty-state">No skills learned yet. Ask to "save a skill".</div>
        </div>
      </div>

      <div id="tab-diagnostics" class="tab-content">
        <div class="pane-header">
          <span>Agent Debug</span>
          <div class="term-header-actions">
            <button id="open-debug-log-btn" class="icon-btn" title="Open full Output channel log">Full log</button>
            <button id="refresh-debug-btn" class="icon-btn" title="Refresh snapshot">Refresh</button>
            <button id="clear-diagnostics-btn" class="icon-btn" title="Clear system diagnostics">Clear</button>
          </div>
        </div>
        <div id="agent-debug-session" class="agent-debug-session"></div>
        <div id="diagnostics-list">
          <div class="empty-state">No agent activity yet. Tools, tokens, mode, and warnings will appear here as you work.</div>
        </div>
      </div>

      <div id="tab-plan" class="tab-content">
        <div class="pane-header">
          <span>Implementation Plan</span>
          <span class="plan-progress"></span>
        </div>
        <div id="plan-list">
          <div class="empty-state">No active plan. Use Planning mode for complex tasks.</div>
        </div>
      </div>

      <div id="tab-timeline" class="tab-content">
        <div id="timeline-list">
          <div class="empty-state">No tool executions yet.</div>
        </div>
      </div>

      <div id="tab-terminal" class="tab-content">
        <div class="pane-header">
          <span>Terminal</span>
          <div class="term-header-actions">
            <button id="term-focus-btn" class="icon-btn" title="Focus VS Code terminal panel">Focus panel</button>
            <button id="term-clear-btn" class="icon-btn" title="Clear log">Clear</button>
          </div>
        </div>
        <div id="terminal-log" class="terminal-log">
          <div class="empty-state">Run commands here or via the agent (<code>run_in_terminal</code>). Output appears below; use the input to type interactively.</div>
        </div>
        <div class="terminal-input-row">
          <input id="terminal-input" type="text" placeholder="Type a command or interactive input…" autocomplete="off" />
          <button id="terminal-send-btn" title="Send (Enter)">Run</button>
        </div>
      </div>
    </div>
  </div>
  <script src="${webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'markdown-it.min.js'))}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}