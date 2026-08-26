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
import { applyEdit, NOT_FOUND } from "./editUtils";
import { scanForSecrets, summarizeFindings } from "./secretScanner";
import { ApprovalPolicy, GatedCategory, GATED_TOOLS, needsApprovalForPolicy, describeToolCall, commandPrefix, matchesApprovedPrefix } from "./approvals";
import { UntrustedContentTracker } from "./promptInjectionGuard";
import { repairJsonParse } from "./jsonRepair";
import { isGitRepo, createGitCheckpoint, restoreFileFromCheckpoint } from "./gitCheckpoint";
import { buildProviderRequest, extractNonStreamedText } from "./aiProviderAdapter";

/** SecretStorage key used to store the LLM provider API key (see migrateApiKeyToSecretStorage). */
const API_KEY_SECRET_KEY = "codepartner.apiKey";

/** Combines a spawned process's stdout/stderr into one trimmed string for display/prompt use. */
function formatOutput(stdout: string, stderr: string): string {
  const parts = [stdout.trim()];
  if (stderr.trim()) {
    parts.push(`STDERR:\n${stderr.trim()}`);
  }
  return parts.filter(Boolean).join("\n\n").trim();
}

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

    // Simulate complex sub-agent logic (In reality, this would be a separate LLM call)
    // For now, we'll use a basic internal prompt or delegate back to handlePrompt with a "subagent" flag
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
          const content = fullContent.length > 5000
            ? fullContent.substring(0, 5000) + "\n... (truncated — page content continues, use grep_search or a narrower selector for more)"
            : fullContent;
          return `Navigated to ${url}. Title: ${title}\nContent Preview: ${content}`;
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
          const clickContent = fullClickContent.length > 3000
            ? fullClickContent.substring(0, 3000) + "\n... (truncated — page content continues)"
            : fullClickContent;
          return `Clicked "${selector}". Page content after click:\n${clickContent}`;
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

### Phase 1: RESEARCH (Mandatory First Step)
Before proposing ANY changes, you MUST thoroughly research:
- Use \`list_dir\` to understand project structure
- Use \`read_file\` to examine relevant source files
- Use \`grep_search\` to find related code, usages, and patterns
- Use \`web_search\` if external documentation or APIs are involved
- DO NOT make any code changes (no edit_file or create_file) during this phase

### Phase 2: IMPLEMENTATION PLAN (Create Before Any Code Changes)
After research, create a detailed plan using \`create_artifact\` with:
- Title: Include "implementation_plan" in the title
- Type: "markdown"
- Content structure:
  # [Goal Description]
  Brief problem description and background context.

  ## Proposed Changes
  ### [Component/Area Name]
  #### [MODIFY] filename.ext - What will change and why
  #### [NEW] new_filename.ext - Purpose of the new file
  #### [DELETE] old_filename.ext - Why this file should be removed

  ## Verification Plan
  How to verify the changes work correctly.

**CRITICAL: After creating the implementation plan, you MUST STOP and tell the user:**
"I have created the implementation plan. Please review it in the Artifacts tab and reply with 'proceed' to execute."
DO NOT execute any code changes until the user explicitly approves.

### Phase 3: EXECUTION (Only After User Approval)
Once the user says 'proceed', 'approved', 'go ahead', 'yes', or similar:
- Create a "task" artifact to track progress
- Execute changes one by one, marking tasks as complete
- Use \`[x]\` for done, \`[ ]\` for pending, \`[/]\` for in-progress

### Phase 4: VERIFICATION & WALKTHROUGH
- Run tests if applicable using \`run_tests\`
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
    description: "Run a shell command in the workspace root.",
    parameters: { type: "object", properties: { command: { type: "string", description: "The command to run." } }, required: ["command"] },
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
    description: "Dispatch a specialized SubAgent for a concurrent sub-task.",
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
    description: "Retrieve instructions from a previously saved skill.",
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
    description: "List all currently available skills.",
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
    description: "Commits staged changes to the git repository.",
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
    description: "Create a GitHub pull request for the current branch.",
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

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      CodePartnerDiffProvider.scheme,
      diffProvider
    )
  );

  const provider = new CodePartnerSidebarProvider(context, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codepartner-sidebar", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codepartner")) {
        provider.refreshModels();
        confirmYoloModeIfNeeded(context, output).then(() => updateAutonomyStatusBar(autonomyStatusBarItem));
      }
    })
  );

  // ── Inline Completion Provider ──
  const inlineProvider = new CodePartnerInlineCompletionProvider(output);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      inlineProvider
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
  private terminal?: vscode.Terminal;
  /** The currently in-flight shell command / test run, if any — killed on cancel (Phase 2.1/2.2). */
  private runningChildProcess?: cp.ChildProcess;
  private gitManager: GitManager;
  private semanticSearch: SemanticSearch;
  private mcpManager: MCPManager;
  private customInstructions: string = "";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
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

    if (root) {
      this.browserManager = new BrowserManager(root);
    }

    // Load custom agent definitions (.codepartner.md)
    this.loadCustomInstructions();

    // Initialize MCP servers
    this.mcpManager.loadConfigs().catch((e: any) => {
      this.output.appendLine(`[CodePartner] MCP init error: ${e.message}`);
    });

    // Build semantic search index in the background
    this.semanticSearch.buildIndex().catch(() => {});

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

  public updateStatus(msg: string) {
    this._view?.webview.postMessage({ type: "status", value: msg });
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
   * Scans text that's about to be sent somewhere external (an LLM prompt,
   * or a GitHub issue in the feedback path) for anything that looks like a
   * credential, and — if found — warns visibly without stripping it. See
   * secretScanner.ts for the rationale.
   */
  private warnIfSecrets(text: string, sourceLabel: string): void {
    const findings = scanForSecrets(text);
    if (findings.length === 0) return;
    const summary = summarizeFindings(findings, sourceLabel);
    this.output.appendLine(`[CodePartner] ${summary}`);
    this._view?.webview.postMessage({ type: "status", value: summary });
  }

  public async runInternalAgent(agentType: string, task: string, personality?: string): Promise<string> {
    // This is a specialized sub-call to the LLM
    const config = vscode.workspace.getConfiguration("codepartner");
    const apiEndpoint = config.get<string>("apiEndpoint")?.trim() || "";
    const apiKey = await this.getApiKey();
    const modelId = this.selectedModelId || config.get<string>("model")?.trim() || "";
    const providerType = config.get<string>("provider") || "openai";
    const azureApiVersion = config.get<string>("azureApiVersion") || "2024-02-15-preview";

    const personalityText = personality ? `\nAdopt this personality trait: ${personality}` : "";
    const subPrompt = `You are a specialized SubAgent: ${agentType}.${personalityText}
Your task is: ${task}
Provide a concise, high-quality result. Do not use tools. Just answer.`;

    const { url, headers, body } = buildProviderRequest({
      providerType, apiEndpoint, apiKey, modelId, azureApiVersion,
      messages: [{ role: "system", content: subPrompt }],
      useSystemRole: true,
      maxTokens: 2048,
      stream: false,
    });

    const res = await axios.post(url, body, { headers });
    return extractNonStreamedText(providerType, res.data);
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

      this.output.appendLine("[CodePartner] Webview view resolved successfully.");
    } catch (e: any) {
      this.output.appendLine(`[CodePartner] Error in resolveWebviewView: ${e.message}`);
      vscode.window.showErrorMessage(`CodePartner Error: ${e.message}`);
    }

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "attachFiles":
          this.handleAttachFiles();
          break;
        case "prompt":
          this.handlePrompt(data.value, data.attachments);
          break;
        case "cancel":
          if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
            this.output.appendLine("[CodePartner] Cancelled by user.");
          }
          if (this.runningChildProcess) {
            this.runningChildProcess.kill();
            this.output.appendLine("[CodePartner] Killed in-flight command/test run.");
            this.runningChildProcess = undefined;
          }
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
          this.output.appendLine(`[CodePartner] Model changed to: ${this.selectedModelId}`);
          break;
        case "changeMode":
          this.executionMode = data.value;
          let promptToUse = FAST_SYSTEM_PROMPT;
          if (this.executionMode === "planning") {
            promptToUse = PLANNING_SYSTEM_PROMPT;
          } else if (this.executionMode === "architect") {
            promptToUse = ARCHITECT_SYSTEM_PROMPT;
          }
          this.messageHistory[0] = { role: "system", content: promptToUse };
          this.output.appendLine(`[CodePartner] Mode changed to: ${this.executionMode}`);
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
            this.saveCurrentChat();
          }
          break;
        case "listTimeline":
          this._view?.webview.postMessage({ type: "timeline", value: this.timelineEvents });
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

      // Add hiddenFromUI flag to context-heavy messages for UI reloading
      const uiHistory = this.messageHistory.map((m, idx) => ({
        ...m,
        hiddenFromUI: idx > 0 && (m.role === "tool" || m.role === "system")
      }));

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

  private newChat() {
    // Save current if it has history
    if (this.messageHistory.length > 1) {
      this.saveCurrentChat();
    }

    this.currentChatId = Date.now().toString();
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

        // Find files
        const files = await vscode.workspace.findFiles(
          `**/*${q}*`,
          "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}",
          20
        );

        for (const f of files) {
          suggestions.push({
            label: "@" + vscode.workspace.asRelativePath(f),
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

      this._view?.webview.postMessage({ type: "suggestions", value: suggestions });
    } catch {
      // ignore
    }
  }

  public refreshModels() {
    this.fetchModels();
  }

  private async fetchModels() {
    const config = vscode.workspace.getConfiguration("codepartner");
    const provider = config.get<string>("provider") || "openai";
    const apiEndpoint = config.get<string>("apiEndpoint")?.trim() || "";
    const apiKey = await this.getApiKey();
    let currentModel = this.selectedModelId || config.get<string>("model") || "";

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
    this._view?.webview.postMessage({
      type: "models",
      value: this.availableModels,
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

    const attached = [];
    for (const file of files) {
      try {
        const content = await fs.promises.readFile(file.fsPath);
        const base64 = content.toString("base64");
        const ext = path.extname(file.fsPath).toLowerCase().substring(1);
        let mimeType = "application/octet-stream";

        if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
          mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;
        } else if (["mp4", "webm", "ogg"].includes(ext)) {
          mimeType = `video/${ext}`;
        } else if (ext === "pdf") {
          mimeType = "application/pdf";
        }

        attached.push({
          name: path.basename(file.fsPath),
          mimeType,
          data: base64
        });
      } catch (e: any) {
        this.output.appendLine(`[CodePartner] Error reading file: ${e.message}`);
      }
    }

    this._view?.webview.postMessage({ type: "fileAttached", value: attached });
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

  private async getFileMentionsContext(prompt: string): Promise<string> {
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
          context += `\n--- File: ${rel} ---\n\`\`\`\n${text}\n\`\`\`\n\n`;
          this.output.appendLine(`[CodePartner] Injected file: ${rel}`);
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
    if (this.messageHistory.length < 15) return;

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

      default:
        this.handlePrompt(commandStr); // Fallback to normal prompt
    }
  }

  private async handlePrompt(prompt: string, attachments: any[] = []) {
    if (!this._view) {
      return;
    }

    // Fresh turn — clear anything tracked for the prompt-injection guard
    // from the previous turn so stale content can't suppress a real check.
    this.untrustedContent.reset();

    // Check for slash command
    if (prompt.startsWith("/")) {
      this.handleSlashCommand(prompt);
      return;
    }

    // Auto-compact if history is getting long
    if (this.messageHistory.length > 40) {
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
    contextHeader += await this.getFileMentionsContext(prompt);

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
        const capped = text.length > 8000 ? text.substring(0, 8000) + "\n... (truncated)" : text;
        contextHeader += `\n--- Context ---\nFile: \`${fileName}\`\nContent:\n\`\`\`\n${capped}\n\`\`\`\n`;
      }
    }

    // Feature 2: Context from other open tabs
    const otherEditors = vscode.window.visibleTextEditors.filter(e => e !== editor).slice(0, 3);
    for (const oe of otherEditors) {
      const doc = oe.document;
      const name = path.basename(doc.fileName);
      const text = doc.getText();
      this.warnIfSecrets(text, name);
      const capped = text.length > 2000 ? text.substring(0, 2000) + "\n... (truncated)" : text;
      contextHeader += `\n--- Context from Open Tab ---\nFile: \`${name}\`\nContent:\n\`\`\`\n${capped}\n\`\`\`\n`;
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
      this.abortController = new AbortController();
      let fullResponse = "";
      let fullReasoning = "";
      let toolCalls: any[] = [];
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
            if (event.data === "[DONE]") {
              return;
            }
            try {
              const parsed = JSON.parse(event.data);
              
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

        let shouldBreakLoop = false;

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
              result = await this.executeTool(tc.function.name, args);

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
                success: !(typeof result === "string" && result.startsWith("Error")),
                timestamp: toolStartTime,
                duration: Date.now() - toolStartTime,
                revertContent,
                path: args.path,
                turnId
              };
              this.timelineEvents.push(evt);
              this._view?.webview.postMessage({ type: "timelineEvent", value: evt });

              // Check for planning mode stop
              if (this.executionMode === "planning" && tc.function.name === "create_artifact") {
                if (args.title?.toLowerCase().includes("implementation_plan")) {
                  shouldBreakLoop = true;
                }
              }

              return { id: tc.id, name: tc.function.name, content: typeof result === "string" ? result : JSON.stringify(result) };
            } catch (e: any) {
              const errResult = `Error executing tool: ${e.message}`;
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

          // Update UI stats
          if (this.modifiedFiles.size > 0) {
            const stats = Array.from(this.modifiedFiles).map(f => ({
              path: f,
              ...(this.fileChangeStats.get(f) || { added: 0, removed: 0 })
            }));
            this._view?.webview.postMessage({ type: "modifiedFiles", value: stats });
          }

          if (shouldBreakLoop) {
            const waitMsg = "I have created the implementation plan. Please review it in the Artifacts tab and reply with 'proceed' to execute.";
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
              if (rawBody.length > 0) msg = rawBody.substring(0, 500);
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
      this._view?.webview.postMessage({ type: "error", value: `❌ **Error:** ${globalErr.message || globalErr}` });
    }
  }

  private extractPlan(response: string): { task: string; done: boolean }[] {
    const lines = response.split("\n");
    let inPlan = false;
    const tasks: { task: string; done: boolean }[] = [];
    for (const line of lines) {
      if (/^#{1,3}\s*(implementation\s*plan|plan|tasks?|todo|roadmap|steps)/i.test(line)) {
        inPlan = true;
        continue;
      }
      if (inPlan && /^#{1,3}\s/.test(line) && !/plan|task|step/i.test(line)) {
        break;
      }
      if (inPlan) {
        const taskMatch = line.match(/^[\s]*(?:[-*]|\d+\.)\s*(?:\[[ x]\]\s*)?(.+)/);
        if (taskMatch) {
          const done = /\[x\]/i.test(line);
          tasks.push({ task: taskMatch[1].trim(), done });
        }
      }
    }
    return tasks;
  }

  private async executeTool(name: string, args: any): Promise<any> {
    if (this.executionMode === "planning") {
      const hasPlan = this.currentArtifacts.some(a => a.title.toLowerCase().includes("plan"));
      if (!hasPlan && (name === "edit_file" || name === "create_file")) {
        return `Error: You are in PLANNING MODE but have not created the "implementation_plan.md" artifact yet. You MUST create the implementation plan and get user approval BEFORE executing code modifications. Use the create_artifact tool.`;
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
        const decision = await this.requestApprovalIfNeeded(name, gatedCategory, args);
        if (decision !== "allow") {
          return `Denied: the user did not approve this ${gatedCategory.replace("-", " ")} action (${name}). Explain what you intended to do and why, then ask how they'd like to proceed.`;
        }
      }
    }

    switch (name) {
      case "run_command":
        return this.runCommand(args.command);
      case "list_dir":
        return this.listDir(args.path);
      case "read_file":
        return this.readFile(args.path);
      case "edit_file":
        return this.editFile(args.path, args.search, args.replace);
      case "create_file":
        return this.createFile(args.path, args.content);
      case "web_search":
        return this.getWebSearchContext(`@web ${args.query}`);
      case "call_subagent":
        return this.agentManager.dispatch(args.agent_type, args.task, this, args.personality);
      case "create_artifact":
        if (this.artifactRegistry) {
          const art = this.artifactRegistry.create(args.title, args.content, args.type);
          this.currentArtifacts.push(art);
          this._view?.webview.postMessage({ type: "artifact", value: art });
          return `Artifact created: ${art.title} (ID: ${art.id})`;
        }
        return "Error: Workspace not open, cannot create artifact.";
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
        return this.grepSearch(args.pattern, args.path, args.include);
      case "run_tests":
        return this.runTests(args.command);
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
  private async requestApprovalIfNeeded(name: string, category: GatedCategory, args: any): Promise<"allow" | "deny"> {
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

    this.output.appendLine(`[CodePartner] Requesting approval for ${name}${flaggedByInjectionGuard ? " (flagged: possible prompt injection)" : ""}: ${description}`);

    const buttons = flaggedByInjectionGuard ? ["Allow", "Deny"] : ["Allow", "Always Allow This Session", "Deny"];
    const choice = await vscode.window.showWarningMessage(
      `${warningPrefix}CodePartner wants to: ${description}`,
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
  private async runCommand(command: string): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
        if (settled) return;
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


  private listDir(relPath: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

  private readFile(relPath: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

  private async editFile(relPath: string, search: string, replace: string): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return "Error: No workspace folder open."; }
    const fullPath = path.join(root, relPath);
    try {
      if (!fs.existsSync(fullPath)) {
        return `Error: File does not exist: ${relPath}. Use create_file for new files.`;
      }

      const originalContent = this.executionMode === "architect" && this.architectDrafts.has(relPath)
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

      if (this.executionMode === "architect") {
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

  private async createFile(relPath: string, content: string): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return "Error: No workspace folder open."; }
    const fullPath = path.join(root, relPath);
    try {
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      if (fs.existsSync(fullPath) && !this.fileBackups.has(relPath)) {
        this.fileBackups.set(relPath, fs.readFileSync(fullPath, "utf8"));
      }

      const lines = content.split(/\r?\n/).filter(l => l.trim() !== "").length;
      this.fileChangeStats.set(relPath, { added: lines, removed: 0 });

      if (this.executionMode === "architect") {
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

  private grepSearch(pattern: string, searchPath?: string, include?: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
   * Auto-detects and runs the test suite via child_process.spawn (async,
   * streamed), instead of the old cp.execSync call which blocked the
   * entire extension host for up to 60s on every test run. Supports
   * cancellation via the "cancel" webview message (see runningChildProcess).
   */
  private async runTests(customCommand?: string): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
        if (settled) return;
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

  private sendArchitectDrafts() {
    const drafts = Array.from(this.architectDrafts.entries()).map(([path, content]) => ({
      path,
      lines: content.split(/\r?\n/).length
    }));
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

  private revertTimelineAction(chatId: string, timestamp: number) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;

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
    if (!root) return;

    const gitRef = this.turnGitCheckpoints.get(turnId);
    const eventsToRevert = this.timelineEvents.filter(e =>
      e.turnId === turnId && !e.reverted && (e.revertContent !== undefined || gitRef !== undefined)
    );
    eventsToRevert.sort((a, b) => b.timestamp - a.timestamp);

    let revertedCount = 0;
    for (const event of eventsToRevert) {
      if (!event.path) continue;
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
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));

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
        <button id="history-btn" class="icon-btn" title="Saved Chats">
          <svg viewBox="0 0 16 16"><path d="M14.5 13.5V12a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v1.5a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5zM2 3V2a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1h1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3h1zm11 0V2H3v1h10zM2 12h12V4H2v8z"/></svg>
        </button>
        <button id="feedback-btn" class="icon-btn" title="Send Feedback / Report Bug">
          <svg viewBox="0 0 16 16"><path d="M1 2a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5l-3 3V2z"/></svg>
        </button>
        <button id="new-chat-btn" class="icon-btn" title="New Chat">
          <svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3 8H9v2H7V9H5V7h2V5h2v2h2v2z"/></svg>
        </button>
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
              <button id="apply-drafts-btn">Apply All Drafts</button>
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
    </div>
  </div>
  <script src="${webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'markdown-it.min.js'))}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}