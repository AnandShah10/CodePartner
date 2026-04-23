import * as vscode from "vscode";
import axios from "axios";
import { createParser } from "eventsource-parser";
import MarkdownIt = require("markdown-it");
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";
import * as os from "os";

class SingleContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChange.event;

  constructor(private content: string) {}

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

  public async dispatch(agentType: string, task: string, provider: CodePartnerSidebarProvider): Promise<string> {
    const id = Math.random().toString(36).substring(7);
    const subtask: SubAgentTask = { id, agentType, task, status: "pending" };
    this.subagents.set(id, subtask);

    provider.updateStatus(`Agent ${agentType} starting task: ${task.substring(0, 30)}...`);
    subtask.status = "running";

    // Simulate complex sub-agent logic (In reality, this would be a separate LLM call)
    // For now, we'll use a basic internal prompt or delegate back to handlePrompt with a "subagent" flag
    try {
      const result = await provider.runInternalAgent(agentType, task);
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
  constructor(private workspaceRoot: string) {}

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

  constructor(private workspaceRoot: string) {}

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

  public async execute(action: string, url?: string): Promise<string> {
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

    const page = await this.browser.newPage();
    try {
      if (action === "navigate" && url) {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });
        const title = await page.title();
        // @ts-ignore
        const content = await page.evaluate(() => document.body.innerText.substring(0, 5000));
        return `Navigated to ${url}. Title: ${title}\nContent Preview: ${content}`;
      } else if (action === "screenshot" && url) {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });
        const id = Date.now().toString();
        const artifactDir = path.join(this.workspaceRoot, ".codepartner", "artifacts");
        if (!fs.existsSync(artifactDir)) { fs.mkdirSync(artifactDir, { recursive: true }); }
        const fileName = `screenshot_${id}.png`;
        const screenshotPath = path.join(artifactDir, fileName);
        await page.screenshot({ path: screenshotPath });
        const artifact = { id, title: `Browser Screenshot: ${url}`, type: "screenshot", content: fileName, filePath: screenshotPath, timestamp: Date.now() };
        return JSON.stringify(artifact);
      }
      return `Action ${action} not implemented or missing URL.`;
    } catch (e: any) {
      return `Browser error: ${e.message}`;
    } finally {
      await page.close();
    }
  }
}

// ─── System Prompts ───────────────────────────────────────────────────────────
const BASE_SYSTEM = `You are CodePartner, a high-level agentic coding assistant.
Capabilities:
- **File Operations**: Read, edit (search/replace), and create files.
- **Shell Commands**: Run terminal commands in the workspace.
- **Multi-Agent**: Delegate to SubAgents (researcher, code_expert, tester, writer).
- **Browser**: Navigate and screenshot web pages.
- **Artifacts**: Save code, docs, or logs as persistent artifacts.
- **Web Search**: Search the web for information.

IMPORTANT RULES:
- For edit_file: provide the EXACT text to search for and the replacement. Do NOT guess — read the file first.
- For new files: use create_file, not edit_file.
- Never truncate code blocks. Provide full, working solutions.
- Always read a file before editing it.`;

const PLANNING_SYSTEM_PROMPT = BASE_SYSTEM + `\n\n## PLANNING MODE
You MUST start every response with a structured Implementation Plan before taking any action.
Format your plan as:

## Implementation Plan
1. Step one description
2. Step two description
...

After presenting the plan, proceed to execute it step by step using tools.
Update the user on progress after each step.`;

const FAST_SYSTEM_PROMPT = BASE_SYSTEM + `\n\n## FAST MODE
Skip planning. Directly address the user's request using tools as needed.
Be concise and action-oriented. Do not generate implementation plans.`;

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
    description: "Control a browser to navigate, search, and take screenshots.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "screenshot"], description: "Action to perform." },
        url: { type: "string", description: "Target URL." },
      },
      required: ["action", "url"],
    },
  },
];

// ─── Activate ─────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("CodePartner");
  context.subscriptions.push(output);
  output.appendLine("CodePartner extension activated.");

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

  output.appendLine("CodePartner: Registered codepartner-sidebar provider.");
  
  context.subscriptions.push(
    vscode.commands.registerCommand("codepartner.focus", () => {
      vscode.commands.executeCommand("workbench.view.extension.codepartner-view-container");
    })
  );
}

export function deactivate() {}

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
  private agentManager: AgentManager;
  private artifactRegistry?: ArtifactRegistry;
  private browserManager?: BrowserManager;
  private currentPlan: { task: string, done: boolean }[] = [];
  private currentArtifacts: any[] = [];
  private executionMode: "planning" | "fast" = "fast";
  private skillManager?: SkillManager;

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
    
    if (root) {
      this.browserManager = new BrowserManager(root);
    }

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
      }
    }
  }

  public updateStatus(msg: string) {
    this._view?.webview.postMessage({ type: "status", value: msg });
  }

  public async runInternalAgent(agentType: string, task: string): Promise<string> {
    // This is a specialized sub-call to the LLM
    const config = vscode.workspace.getConfiguration("codepartner");
    const apiEndpoint = config.get<string>("apiEndpoint")?.trim() || "";
    const apiKey = config.get<string>("apiKey")?.trim() || "";
    const modelId = this.selectedModelId || config.get<string>("model")?.trim() || "";
    const providerType = config.get<string>("provider") || "openai";
    const azureApiVersion = config.get<string>("azureApiVersion") || "2024-02-15-preview";

    const subPrompt = `You are a specialized SubAgent: ${agentType}.
Your task is: ${task}
Provide a concise, high-quality result. Do not use tools. Just answer.`;

    const body = {
      model: modelId,
      messages: [{ role: "system", content: subPrompt }],
      max_tokens: 2048,
    };

    const res = await axios.post(`${apiEndpoint}/chat/completions`, body, {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    return res.data.choices[0].message.content;
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
          this.executionMode = data.value === "planning" ? "planning" : "fast";
          this.messageHistory[0] = { role: "system", content: this.executionMode === "planning" ? PLANNING_SYSTEM_PROMPT : FAST_SYSTEM_PROMPT };
          this.output.appendLine(`[CodePartner] Mode changed to: ${this.executionMode}`);
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
      }
    });
  }

  private sendChatsToWebview() {
    const chats = this.context.workspaceState.get<any[]>("cp-chats", []);
    this._view?.webview.postMessage({ type: "chatHistory", value: chats });
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

      // Add hiddenFromUI flag to context-heavy messages for UI reloading
      const uiHistory = this.messageHistory.map((m, idx) => ({
        ...m,
        hiddenFromUI: idx > 0 && (m.role === "tool" || m.role === "system")
      }));

      this._view?.webview.postMessage({ type: "loadMessages", value: uiHistory });
      this._view?.webview.postMessage({ type: "plan", value: this.currentPlan });
      this.currentArtifacts.forEach(a => this._view?.webview.postMessage({ type: "artifact", value: a }));
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
    this.messageHistory = [{ role: "system", content: this.executionMode === "planning" ? PLANNING_SYSTEM_PROMPT : FAST_SYSTEM_PROMPT }];
    this.currentPlan = [];
    this.currentArtifacts = [];
    this._view?.webview.postMessage({ type: "loadMessages", value: [] });
    this._view?.webview.postMessage({ type: "plan", value: [] });
    this.context.workspaceState.update("cp-last-chat-id", this.currentChatId);
    this.sendChatsToWebview();
  }

  private async suggestFiles(query: string) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return;
    }

    const q = query.toLowerCase();
    const suggestions: any[] = [
      { label: "@web", detail: "Search the web", type: "special" },
      { label: "@workspace", detail: "Entire workspace context", type: "special" },
    ];

    try {
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

      this._view?.webview.postMessage({ type: "suggestions", value: suggestions });
    } catch {
      // ignore
    }
  }

  private async fetchModels() {
    const config = vscode.workspace.getConfiguration("codepartner");
    const provider = config.get<string>("provider") || "openai";
    const apiEndpoint = config.get<string>("apiEndpoint")?.trim() || "";
    const apiKey = config.get<string>("apiKey")?.trim() || "";
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
        
        // Slightly smarter filter: prefer LLMs over embeddings if many exist
        const llmKeywords = ["gpt", "claude", "gemini", "llama", "mistral", "phi"];
        const filtered = this.availableModels.filter(m => llmKeywords.some(kw => m.id.toLowerCase().includes(kw)));
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
          context += `\n--- File: ${rel} ---\n\`\`\`\n${doc.getText()}\n\`\`\`\n\n`;
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
        return `\n--- Web Search Results for "${query}" ---\n` + parts.map((p, i) => `${i + 1}. ${p}`).join("\n\n") + "\n\n";
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
        return `\n--- Web Search Results for "${query}" ---\n` + snippets.map((s, i) => `${i + 1}. ${s}`).join("\n\n") + "\n\n";
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
      const files = await vscode.workspace.findFiles("**/*", "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}", 200);
      const paths = files.map((f) => vscode.workspace.asRelativePath(f)).sort();
      let context = `\n--- Workspace Structure (${paths.length} files) ---\n${paths.join("\n")}\n\n`;

      // Content-aware search: extract keywords and find relevant files
      const keywords = prompt.replace(/@workspace/gi, "").trim().split(/\s+/).filter(w => w.length > 2);
      if (keywords.length > 0) {
        const relevantFiles: { path: string; matches: string[] }[] = [];
        for (const file of files.slice(0, 100)) {
          try {
            const doc = await vscode.workspace.openTextDocument(file);
            const text = doc.getText();
            if (text.length > 500000) { continue; }
            const lines = text.split("\n");
            const matchingLines = lines.filter(line =>
              keywords.some(kw => line.toLowerCase().includes(kw.toLowerCase()))
            );
            if (matchingLines.length > 0) {
              relevantFiles.push({
                path: vscode.workspace.asRelativePath(file),
                matches: matchingLines.slice(0, 3).map(l => l.trim())
              });
            }
          } catch { /* skip binary/large */ }
        }
        if (relevantFiles.length > 0) {
          context += `\n--- Relevant Content (keywords: ${keywords.join(", ")}) ---\n`;
          relevantFiles.slice(0, 10).forEach(r => {
            context += `\nFile: ${r.path}\n${r.matches.map(m => `  > ${m}`).join("\n")}\n`;
          });
          context += "\n";
        }
      }
      return context;
    } catch {
      return "";
    }
  }

  private async handlePrompt(prompt: string, attachments: any[] = []) {
    if (!this._view) {
      return;
    }
    this._view.webview.postMessage({ type: "status", value: "Preparing context..." });

    const config = vscode.workspace.getConfiguration("codepartner");
    const apiEndpoint = config.get<string>("apiEndpoint")?.trim() || "";
    const apiKey = config.get<string>("apiKey")?.trim() || "";
    const modelId = this.selectedModelId || config.get<string>("model")?.trim() || "";
    const providerType = config.get<string>("provider") || "openai";
    const azureApiVersion = config.get<string>("azureApiVersion") || "2024-02-15-preview";
    let maxTokens = config.get<number>("maxTokens") || 4096;

    if (!apiEndpoint || !apiKey || !modelId) {
      this._view.webview.postMessage({
        type: "error",
        value: "⚠️ **CodePartner not configured.**\\n\\nOpen **Settings** and set:\\n- `codepartner.provider`\\n- `codepartner.apiEndpoint`\\n- `codepartner.apiKey`\\n- `codepartner.model`"
      });
      return;
    }

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
        contextHeader += `\n--- Context ---\nFile: \`${fileName}\`\nSelected Code:\n\`\`\`\n${code}\n\`\`\`\n`;
      } else {
        const text = document.getText();
        const capped = text.length > 8000 ? text.substring(0, 8000) + "\n… (truncated)" : text;
        contextHeader += `\n--- Context ---\nFile: \`${fileName}\`\nContent:\n\`\`\`\n${capped}\n\`\`\`\n`;
      }
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
    const maxIterations = 10;
    let useTools = true;
    let useSystemRole = true;

    while (iteration < maxIterations) {
      iteration++;
      this.abortController = new AbortController();
      let fullResponse = "";
      let fullReasoning = "";
      let toolCalls: any[] = [];
      this.modifiedFiles.clear();

      const endpoint = apiEndpoint.replace(/\/$/, "");
      let url = "";
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (providerType === "azure") {
        url = `${endpoint}/openai/deployments/${modelId}/chat/completions?api-version=${azureApiVersion}`;
        headers["api-key"] = apiKey;
      } else {
        url = `${endpoint}/chat/completions`;
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const body: Record<string, unknown> = {
        messages: this.messageHistory.map((m) => {
          const msg: any = { role: m.role === "system" && !useSystemRole ? "user" : m.role, content: m.content };
          if (m.tool_calls) {
            msg.tool_calls = m.tool_calls;
          }
          if (m.tool_call_id) {
            msg.tool_call_id = m.tool_call_id;
            // The tool result message needs 'name' if it was a function call
            if (m.name) msg.name = m.name;
          }
          if (m.name && m.role !== "tool") {
            msg.name = m.name;
          }
          return msg;
        }),
        max_tokens: maxTokens,
        temperature: 0.1,
        stream: true,
      };

      if (useTools) {
        body.tools = TOOLS.map((t) => ({ type: "function", function: t }));
        body.tool_choice = "auto";
      }

      if (providerType !== "azure") {
        body.model = modelId;
      }

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
              const delta = parsed.choices?.[0]?.delta;
              if (!delta) {
                return;
              }
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

        // Extract and send plan if present
        if (iteration === 1) {
          const extractedPlan = this.extractPlan(fullResponse);
          if (extractedPlan.length > 0) {
            this.currentPlan = extractedPlan;
            this._view?.webview.postMessage({ type: "plan", value: this.currentPlan });
          }
          // In planning mode, also send the full plan document to the Plan tab
          if (this.executionMode === "planning") {
            const planDocMatch = fullResponse.match(/## Implementation Plan[\s\S]*?(?=\n## [^I]|$)/i);
            if (planDocMatch) {
              this._view?.webview.postMessage({ type: "planDocument", value: planDocMatch[0] });
              // Also save as artifact
              if (this.artifactRegistry) {
                const art = this.artifactRegistry.create("Implementation Plan", planDocMatch[0], "markdown");
                this.currentArtifacts.push(art);
                this._view?.webview.postMessage({ type: "artifact", value: art });
              }
            }
          }
        }

        if (toolCalls.length > 0) {
          const assistantMessage = { role: "assistant", content: fullResponse || null, tool_calls: toolCalls };
          this.messageHistory.push(assistantMessage);

          for (const tc of toolCalls) {
            this.output.appendLine(`[CodePartner] Calling tool: ${tc.function.name}`);
            this._view.webview.postMessage({ type: "status", value: `Executing ${tc.function.name}...` });
            let result;
            try {
              const args = JSON.parse(tc.function.arguments);
              result = await this.executeTool(tc.function.name, args);

              // Map tool completion to plan tasks (progressive)
              this._view?.webview.postMessage({ type: "completeTask", value: iteration - 1 });

              if (tc.function.name === "edit_file" && !result.startsWith("Error")) {
                this.modifiedFiles.add(args.path);
                const stats = Array.from(this.modifiedFiles).map(f => ({
                  path: f,
                  ...(this.fileChangeStats.get(f) || { added: 0, removed: 0 })
                }));
                this._view?.webview.postMessage({ type: "modifiedFiles", value: stats });
              }
            } catch (e: any) {
              result = `Error executing tool: ${e.message}`;
            }
            this.messageHistory.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.function.name,
              content: typeof result === "string" ? result : JSON.stringify(result),
            });
          }
          continue;
        } else {
          if (fullResponse) {
            this.messageHistory.push({ role: "assistant", content: fullResponse });
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
              err.response.data.on("data", (c: Buffer) => chunks.push(c));
              err.response.data.on("end", () => resolve(Buffer.concat(chunks)));
              err.response.data.on("error", reject);
            });
            const errorData = JSON.parse(dataBuffer.toString());
            msg = errorData?.error?.message || msg;
          } catch (e) {
            // ignore error while parsing stream
          }
        } else if (err?.response?.data?.error?.message) {
          msg = err.response.data.error.message;
        }
        
        if (status === 400) {
          // Check if max_tokens is too large
          const maxTokensMatch = msg.match(/at most (\d+) completion tokens/i);
          if (maxTokensMatch && maxTokens > parseInt(maxTokensMatch[1], 10)) {
            maxTokens = parseInt(maxTokensMatch[1], 10);
            this.output.appendLine(`[CodePartner] API indicated max_tokens too high. Adjusting to ${maxTokens} and retrying...`);
            iteration--;
            continue;
          }

          // Fallback sequence for 400 errors: progressively disable features
          if (useTools) {
            this.output.appendLine(`[CodePartner] 400 API Error: ${msg}. Retrying without tools as fallback...`);
            useTools = false;
            iteration--;
            continue;
          }
          if (useSystemRole) {
            this.output.appendLine(`[CodePartner] 400 API Error: ${msg}. Retrying without system role as fallback...`);
            useSystemRole = false;
            iteration--;
            continue;
          }
        }

        this._view?.webview.postMessage({ type: "error", value: `❌ **Error${status ? ` (${status})` : ""}:** ${msg}` });
        break;
      } finally {
        this.abortController = undefined;
        this.saveCurrentChat();
      }
    }
    this._view?.webview.postMessage({ type: "done" });
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
        return this.agentManager.dispatch(args.agent_type, args.task, this);
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
        const result = await this.browserManager.execute(args.action, args.url);
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
      default:
        return `Error: Tool not found: ${name}`;
    }
  }

  private runCommand(command: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return "No workspace open.";
    }
    try {
      const output = cp.execSync(command, { cwd: root, encoding: "utf8", timeout: 30000 });
      return output || "(Done, no output)";
    } catch (e: any) {
      return `Command failed: ${e.message}\nSTDOUT: ${e.stdout}\nSTDERR: ${e.stderr}`;
    }
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
      return fs.readFileSync(fullPath, "utf8");
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
      const originalContent = fs.readFileSync(fullPath, "utf8");
      if (!this.fileBackups.has(relPath)) {
        this.fileBackups.set(relPath, originalContent);
      }

      // Exact match first
      let newContent: string;
      if (originalContent.includes(search)) {
        newContent = originalContent.replace(search, replace);
      } else {
        // Fuzzy fallback: trim whitespace on each line and try matching
        const searchTrimmed = search.split("\n").map(l => l.trim()).join("\n");
        const contentLines = originalContent.split("\n");
        const contentTrimmed = contentLines.map(l => l.trim()).join("\n");
        const idx = contentTrimmed.indexOf(searchTrimmed);
        if (idx === -1) {
          return `Error: Could not find the search text in ${relPath}. Please read_file first and use the exact text.`;
        }
        // Find the original line range
        const beforeTrimmed = contentTrimmed.substring(0, idx);
        const startLine = beforeTrimmed.split("\n").length - 1;
        const searchLineCount = searchTrimmed.split("\n").length;
        const beforeLines = contentLines.slice(0, startLine);
        const afterLines = contentLines.slice(startLine + searchLineCount);
        newContent = [...beforeLines, replace, ...afterLines].join("\n");
      }

      const oldLines = originalContent.split(/\r?\n/).filter(l => l.trim() !== "");
      const newLines = newContent.split(/\r?\n/).filter(l => l.trim() !== "");
      const removed = oldLines.filter(l => !newLines.includes(l)).length;
      const added = newLines.filter(l => !oldLines.includes(l)).length;
      this.fileChangeStats.set(relPath, { added, removed });

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
      fs.writeFileSync(fullPath, content, "utf8");
      const lines = content.split(/\r?\n/).filter(l => l.trim() !== "").length;
      this.fileChangeStats.set(relPath, { added: lines, removed: 0 });
      return `File ${relPath} created successfully. ${lines} lines.`;
    } catch (e: any) {
      return `Error creating file: ${e.message}`;
    }
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
        <button id="new-chat-btn" class="icon-btn" title="New Chat">
          <svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3 8H9v2H7V9H5V7h2V5h2v2h2v2z"/></svg>
        </button>
      </div>
    </div>

    <div id="tab-bar">
      <button class="tab-btn active" data-tab="chat">Chat</button>
      <button class="tab-btn" data-tab="plan">Plan</button>
      <button class="tab-btn" data-tab="artifacts">Artifacts</button>
      <button class="tab-btn" data-tab="skills">Skills</button>
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
            <div id="suggestion-list" class="hidden"></div>
            <div id="attachment-chips" class="hidden"></div>
            <div id="input-container">
              <textarea id="prompt-input" rows="1" placeholder="Ask anything..."></textarea>
              <div class="input-footer">
                <div class="tag-hints">
                  <button id="attach-btn" class="icon-btn" title="Attach Files">
                    <svg viewBox="0 0 16 16"><path d="M4.496 6.675l.66 6.623C5.336 14.445 6.297 16 7.494 16h4c1.197 0 2.158-1.445 2.338-2.552l.66-6.623a.75.75 0 0 0-1.492-.15l-.66 6.623a.853.853 0 0 1-.845.727H7.494a.853.853 0 0 1-.845-.727l-.66-6.623a.75.75 0 0 0-1.492-.15zM2.75 3.5h10.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5z"/></svg>
                  </button>
                  <div class="mode-toggle">
                    <button id="mode-fast" class="mode-btn active" title="Fast Mode (no planning)">
                      <svg viewBox="0 0 16 16"><path d="M11.251.068a.999.999 0 0 1 .697 1.39L9.07 6h4.18a1 1 0 0 1 .75 1.664l-7.25 8.25a1 1 0 0 1-1.697-1.054L7.93 10H3.75a1 1 0 0 1-.75-1.664l7.25-8.25a1 1 0 0 1 1.001-.018z"/></svg>
                      Fast
                    </button>
                    <button id="mode-plan" class="mode-btn" title="Planning Mode (creates implementation plan)">
                      <svg viewBox="0 0 16 16"><path d="M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2h6v1H5V5zm0 2h6v1H5V7zm0 2h4v1H5V9z"/></svg>
                      Plan
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

      <div id="tab-plan" class="tab-content">
        <div class="pane-header">Implementation Plan <span class="plan-progress"></span></div>
        <div id="plan-list">
          <div class="empty-state"><svg viewBox="0 0 16 16"><path d="M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2h6v1H5V5zm0 2h6v1H5V7zm0 2h4v1H5V9z"/></svg>No active plan. Use Planning mode for complex tasks.</div>
        </div>
      </div>

      <div id="tab-artifacts" class="tab-content">
        <div class="pane-header">Stored Artifacts</div>
        <div id="artifact-list">
          <div class="empty-state"><svg viewBox="0 0 16 16"><path d="M4 1.75V14h8V4.75L9.25 1.75H4zM3.25 0h6a.75.75 0 0 1 .53.22l3.5 3.5a.75.75 0 0 1 .22.53v10.5A1.25 1.25 0 0 1 12.25 16H3.75A1.25 1.25 0 0 1 2.5 14.75V1.25C2.5.56 3.06 0 3.75 0h-.5z"/></svg>No artifacts created yet.</div>
        </div>
      </div>

      <div id="tab-skills" class="tab-content">
        <div class="pane-header">Learned Skills</div>
        <div id="skill-list">
          <div class="empty-state"><svg viewBox="0 0 16 16"><path d="M11 2a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3h6z"/></svg>No skills learned yet. Ask to "save a skill".</div>
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