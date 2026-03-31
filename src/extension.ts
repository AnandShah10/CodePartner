import * as vscode from "vscode";
import axios from "axios";
import { createParser } from "eventsource-parser";
import MarkdownIt = require("markdown-it");
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";

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

// ─── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are CodePartner, an expert AI agentic assistant.
You can use tools to interact with the system, run commands, and manage files.
Follow this workflow:
1. **Think**: Analyze the task and plan your steps.
2. **Act**: Use a tool if needed.
3. **Observe**: Review the tool output and adjust your plan.
4. **Answer**: Provide the final result once the task is complete.

Always use the provided tools for workspace interactions.`;

const TOOLS = [
  {
    name: "run_command",
    description: "Run a shell command in the workspace root.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
      },
      required: ["command"],
    },
  },
  {
    name: "list_dir",
    description: "List contents of a directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the directory." },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file." },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_file",
    description: "Replace or update content in a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file." },
        content: { type: "string", description: "The new content for the file." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "web_search",
    description: "Search the web for information using DuckDuckGo.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
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
}

export function deactivate() {}

// ─── Sidebar Provider ─────────────────────────────────────────────────────────
class CodePartnerSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private messageHistory: any[] = [];
  private abortController?: AbortController;
  private currentChatId: string;
  private modifiedFiles: Set<string> = new Set();
  private fileBackups: Map<string, string> = new Map();
  private fileChangeStats: Map<string, { added: number, removed: number }> = new Map();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    this.currentChatId = Date.now().toString();
    this.messageHistory = [{ role: "system", content: SYSTEM_PROMPT }];
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
      this.output.appendLine("[CodePartner] Webview view resolved successfully.");
    } catch (e: any) {
      this.output.appendLine(`[CodePartner] Error in resolveWebviewView: ${e.message}`);
      vscode.window.showErrorMessage(`CodePartner Error: ${e.message}`);
    }

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "prompt":
          this.handlePrompt(data.value);
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
        case "listChats":
          this.sendChatsToWebview();
          break;
        case "openFile":
          this.openFileInEditor(data.value);
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
      timestamp: Date.now()
    };

    if (existingIndex > -1) {
      chats[existingIndex] = updatedChat;
    } else {
      chats.unshift(updatedChat);
    }
    
    this.context.workspaceState.update("cp-chats", chats.slice(0, 50)); // Keep last 50
    this.sendChatsToWebview();
  }

  private loadChat(id: string) {
    const chats = this.context.workspaceState.get<any[]>("cp-chats", []);
    const chat = chats.find(c => c.id === id);
    if (chat) {
      this.currentChatId = chat.id;
      this.messageHistory = chat.messages;
      this._view?.webview.postMessage({ type: "loadMessages", value: this.messageHistory });
    }
  }

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

  private newChat() {
    this.currentChatId = Date.now().toString();
    this.messageHistory = [{ role: "system", content: SYSTEM_PROMPT }];
    this._view?.webview.postMessage({ type: "loadMessages", value: [] });
    this.sendChatsToWebview();
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
      return `\n--- Workspace Structure (${paths.length} files) ---\n${paths.join("\n")}\n\n`;
    } catch {
      return "";
    }
  }

  private async handlePrompt(prompt: string) {
    if (!this._view) {
      return;
    }
    this._view.webview.postMessage({ type: "status", value: "Preparing context..." });

    const config = vscode.workspace.getConfiguration("codepartner");
    const apiEndpoint = config.get<string>("apiEndpoint")?.trim() || "";
    const apiKey = config.get<string>("apiKey")?.trim() || "";
    const modelId = config.get<string>("model")?.trim() || "";
    const providerType = config.get<string>("provider") || "openai";
    const azureApiVersion = config.get<string>("azureApiVersion") || "2024-02-15-preview";
    const maxTokens = config.get<number>("maxTokens") || 2048;

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

    const finalPrompt = contextHeader.length > 0 ? `${contextHeader}\n\nUser Question:\n${prompt}` : prompt;
    this.messageHistory.push({ role: "user", content: finalPrompt });

    // Clear stats for the new message
    this.fileChangeStats.clear();
    this.modifiedFiles.clear();

    let iteration = 0;
    const maxIterations = 10;

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
          const msg: any = { role: m.role, content: m.content };
          if (m.tool_calls) {
            msg.tool_calls = m.tool_calls;
          }
          if (m.tool_call_id) {
            msg.tool_call_id = m.tool_call_id;
          }
          if (m.name) {
            msg.name = m.name;
          }
          return msg;
        }),
        max_tokens: maxTokens,
        temperature: 0.1,
        stream: true,
        tools: TOOLS.map((t) => ({ type: "function", function: t })),
        tool_choice: "auto",
      };
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
        const msg = err?.response?.data?.error?.message || err?.message || String(err);
        this._view?.webview.postMessage({ type: "error", value: `❌ **Error${status ? ` (${status})` : ""}:** ${msg}` });
        break;
      } finally {
        this.abortController = undefined;
        this.saveCurrentChat();
      }
    }
    this._view?.webview.postMessage({ type: "done" });
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
        return this.editFile(args.path, args.content);
      case "web_search":
        return this.getWebSearchContext(`@web ${args.query}`);
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

  private async editFile(relPath: string, content: string): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return "Error: No workspace folder open.";
    }
    const fullPath = path.join(root, relPath);
    try {
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let originalContent = "";
      if (fs.existsSync(fullPath)) {
        originalContent = fs.readFileSync(fullPath, "utf8");
        // Back up for revert if not already backed up this session
        if (!this.fileBackups.has(relPath)) {
          this.fileBackups.set(relPath, originalContent);
        }
      }

      // Simple line diff for summary
      const oldLines = originalContent.split(/\r?\n/).filter(l => l.trim() !== "");
      const newLines = content.split(/\r?\n/).filter(l => l.trim() !== "");
      
      const removed = oldLines.filter(l => !newLines.includes(l)).length;
      const added = newLines.filter(l => !oldLines.includes(l)).length;

      this.fileChangeStats.set(relPath, { added, removed });

      fs.writeFileSync(fullPath, content, "utf8");
      return `File ${relPath} updated successfully. +${added} -${removed} lines.`;
    } catch (e: any) {
      return `Error editing file: ${e.message}`;
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
  <link href="${styleUri}" rel="stylesheet" />
  <title>CodePartner</title>
</head>
<body>
  <div id="app">
    <div id="header">
      <div id="header-title">
        <svg class="logo" viewBox="0 0 16 16"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2a5 5 0 1 1 0 10A5 5 0 0 1 8 3zm-.5 2v3.25l2.6 1.5.5-.87L8.5 7.5V5h-1z"/></svg>
        CodePartner
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

    <div id="main-content">
      <div id="history-panel" class="hidden">
        <div class="panel-header">
          <span>Saved Chats</span>
          <button id="close-history" class="icon-btn" title="Close"><svg viewBox="0 0 16 16"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/></svg></button>
        </div>
        <div id="chat-list"></div>
      </div>

      <div id="chat-container">
        <div id="chat-history"></div>
        <div id="status-bar"><div id="status-text"></div></div>
        <div id="input-outer">
          <div id="input-container">
            <textarea id="prompt-input" rows="1" placeholder="Ask anything..."></textarea>
            <div class="input-footer">
              <div class="tag-hints">
                <span class="tag-hint" onclick="insertTag('@web ')">@web</span>
                <span class="tag-hint" onclick="insertTag('@workspace')">@workspace</span>
              </div>
              <button id="send-btn" title="Send (Enter)">
                <svg viewBox="0 0 16 16"><path d="M1.724 1.053a.5.5 0 0 0-.714.545l1.403 4.85a.5.5 0 0 0 .397.354l5.69.953c.268.053.268.437 0 .49l-5.69.953a.5.5 0 0 0-.397.354l-1.403 4.85a.5.5 0 0 0 .714.545l13-6.5a.5.5 0 0 0 0-.894l-13-6.5Z"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}