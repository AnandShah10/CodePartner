import * as vscode from "vscode";
import axios from "axios";
import { createParser } from "eventsource-parser";
import MarkdownIt = require("markdown-it");
import * as path from "path";

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
const SYSTEM_PROMPT = `You are CodePartner, an expert AI coding assistant embedded in VS Code.
You help users write, debug, refactor, and understand code.
Always respond with clear, concise explanations and well-formatted code blocks.
When showing code, always specify the language in the code fence.
If the user shares code context or searches the web/workspace, analyze it completely.`;

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

  const provider = new CodePartnerSidebarProvider(context.extensionUri, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codepartner-sidebar", provider)
  );
}

export function deactivate() {}

// ─── Sidebar Provider ─────────────────────────────────────────────────────────
class CodePartnerSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private messageHistory: { role: string; content: string }[] = [];
  private abortController?: AbortController;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {
    this.messageHistory = [{ role: "system", content: SYSTEM_PROMPT }];
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this.getHtmlForWebview();

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
          this.applyDiffToEditor(data.value);
          break;
        case "copyCode":
          vscode.env.clipboard.writeText(data.value);
          vscode.window.showInformationMessage("CodePartner: Code copied to clipboard.");
          break;
        case "insertCode":
          this.insertCodeAtCursor(data.value);
          break;
        case "clearChat":
          this.messageHistory = [{ role: "system", content: SYSTEM_PROMPT }];
          break;
      }
    });
  }

  // ── Insert code at cursor (no diff) ────────────────────────────────────────
  private async insertCodeAtCursor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("CodePartner: No active editor to insert into.");
      return;
    }
    await editor.edit((editBuilder) => {
      if (!editor.selection.isEmpty) {
        editBuilder.replace(editor.selection, code);
      } else {
        editBuilder.insert(editor.selection.active, code);
      }
    });
    vscode.window.showInformationMessage("CodePartner: Code inserted.");
  }

  // ── Apply diff ─────────────────────────────────────────────────────────────
  private async applyDiffToEditor(aiCode: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("CodePartner: Open a file to apply a diff.");
      return;
    }

    const document = editor.document;
    const selection = editor.selection;
    let proposedFullContent: string;

    if (!selection.isEmpty) {
      // Replace ONLY the selected region — keep everything else intact
      const before = document.getText(
        new vscode.Range(new vscode.Position(0, 0), selection.start)
      );
      const after = document.getText(
        new vscode.Range(
          selection.end,
          document.lineAt(document.lineCount - 1).range.end
        )
      );
      proposedFullContent = before + aiCode + after;
    } else {
      // No selection → treat AI code as full-file replacement
      proposedFullContent = aiCode;
    }

    diffProvider.update(proposedFullContent);

    const originalUri = document.uri;
    const ext = path.extname(document.fileName) || ".txt";
    const proposedUri = vscode.Uri.parse(
      `${CodePartnerDiffProvider.scheme}:Proposed_Change${ext}`
    );

    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      proposedUri,
      "CodePartner: Review Changes ← original | proposed →"
    );
  }

  // ── @filename context ──────────────────────────────────────────────────────
  private async getFileMentionsContext(prompt: string): Promise<string> {
    const mentionRegex = /@([a-zA-Z0-9_\-./\\]+)/g;
    let match;
    let context = "";
    const seen = new Set<string>();

    while ((match = mentionRegex.exec(prompt)) !== null) {
      const filename = match[1];
      if (["web", "workspace"].includes(filename)) continue;
      if (seen.has(filename)) continue;
      seen.add(filename);

      try {
        let files = await vscode.workspace.findFiles(
          `**/${filename}`,
          "{**/node_modules/**,**/.git/**,**/dist/**}",
          1
        );
        if (!files.length) {
          files = await vscode.workspace.findFiles(
            `**/*${filename}*`,
            "{**/node_modules/**,**/dist/**}",
            1
          );
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

  // ── @web search ────────────────────────────────────────────────────────────
  private async getWebSearchContext(prompt: string): Promise<string> {
    if (!prompt.includes("@web")) return "";

    const queryMatch = prompt.match(/@web\s+(.*)/i);
    const query = queryMatch ? queryMatch[1].trim() : prompt.replace(/@web/gi, "").trim();
    if (!query) return "";

    this._view?.webview.postMessage({ type: "status", value: "🔍 Searching the web…" });

    try {
      this.output.appendLine(`[CodePartner] Web search: ${query}`);

      // Primary: DuckDuckGo Instant Answer JSON API
      const res = await axios.get(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
        { timeout: 8000, headers: { "User-Agent": "CodePartner-VSCode/1.0" } }
      );

      const data = res.data as any;
      const parts: string[] = [];

      if (data.AbstractText) parts.push(data.AbstractText);
      if (data.Answer) parts.push(data.Answer);
      if (Array.isArray(data.RelatedTopics)) {
        data.RelatedTopics.slice(0, 4).forEach((t: any) => {
          if (t.Text) parts.push(t.Text);
        });
      }

      if (parts.length > 0) {
        return (
          `\n--- Web Search Results for "${query}" ---\n` +
          parts.map((p, i) => `${i + 1}. ${p}`).join("\n\n") +
          "\n\n"
        );
      }

      // Fallback: DuckDuckGo HTML scrape
      const htmlRes = await axios.get(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } }
      );
      const html = htmlRes.data as string;
      const snippetRegex = /<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/g;
      const snippets: string[] = [];
      let m;
      while ((m = snippetRegex.exec(html)) !== null && snippets.length < 4) {
        snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      if (snippets.length) {
        return (
          `\n--- Web Search Results for "${query}" ---\n` +
          snippets.map((s, i) => `${i + 1}. ${s}`).join("\n\n") +
          "\n\n"
        );
      }
    } catch (e: any) {
      this.output.appendLine(`[CodePartner] Web search error: ${e.message}`);
    }

    return `\n--- Web Search Failed ---\nNo results for "${query}".\n\n`;
  }

  // ── @workspace ─────────────────────────────────────────────────────────────
  private async getWorkspaceContext(prompt: string): Promise<string> {
    if (!prompt.includes("@workspace")) return "";
    this._view?.webview.postMessage({ type: "status", value: "📂 Scanning workspace…" });
    try {
      const files = await vscode.workspace.findFiles(
        "**/*",
        "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}",
        200
      );
      const paths = files.map((f) => vscode.workspace.asRelativePath(f)).sort();
      return `\n--- Workspace Structure (${paths.length} files) ---\n${paths.join("\n")}\n\n`;
    } catch {
      return "";
    }
  }

  // ── Main handler ────────────────────────────────────────────────────────────
  private async handlePrompt(prompt: string) {
    if (!this._view) return;

    this._view.webview.postMessage({ type: "status", value: "Preparing context…" });

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
        value:
          "⚠️ **CodePartner not configured.**\n\nOpen **Settings** and set:\n- `codepartner.provider`\n- `codepartner.apiEndpoint`\n- `codepartner.apiKey`\n- `codepartner.model`",
      });
      return;
    }

    let contextHeader = "";
    contextHeader += await this.getWebSearchContext(prompt);
    contextHeader += await this.getWorkspaceContext(prompt);
    contextHeader += await this.getFileMentionsContext(prompt);

    // Active editor context
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
        const capped =
          text.length > 8000 ? text.substring(0, 8000) + "\n… (truncated)" : text;
        contextHeader += `\n--- Context ---\nFile: \`${fileName}\`\nContent:\n\`\`\`\n${capped}\n\`\`\`\n`;
      }
    }

    const finalPrompt =
      contextHeader.length > 0
        ? `${contextHeader}\n\nUser Question:\n${prompt}`
        : prompt;

    this.messageHistory.push({ role: "user", content: finalPrompt });

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
      messages: this.messageHistory.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: true,
    };
    if (providerType !== "azure") body.model = modelId;

    this.output.appendLine(`[CodePartner] POST → ${url}`);
    this._view.webview.postMessage({ type: "status", value: "Thinking…" });

    this.abortController = new AbortController();
    let fullResponse = "";

    try {
      const response = await axios.post(url, body, {
        headers,
        responseType: "stream",
        signal: this.abortController.signal,
      });

      const parser = createParser({
        onEvent: (event) => {
          if (event.data === "[DONE]") return;
          try {
            const parsed = JSON.parse(event.data);
            const content = parsed.choices?.[0]?.delta?.content ?? "";
            if (content) {
              fullResponse += content;
              this._view?.webview.postMessage({
                type: "partial",
                value: md.render(fullResponse),
              });
            }
          } catch {
            // ignore malformed chunks
          }
        },
      });

      await new Promise<void>((resolve, reject) => {
        response.data.on("data", (chunk: Buffer) => parser.feed(chunk.toString("utf8")));
        response.data.on("end", resolve);
        response.data.on("error", reject);
      });

      if (fullResponse) {
        this.messageHistory.push({ role: "assistant", content: fullResponse });
      }

      this._view.webview.postMessage({ type: "done" });
      this.output.appendLine("[CodePartner] Request complete.");
    } catch (err: any) {
      if (axios.isCancel(err) || err.name === "CanceledError") return;

      const status = err?.response?.status;
      const msg =
        err?.response?.data?.error?.message || err?.message || String(err);
      this.output.appendLine(`[CodePartner] Error (${status ?? "?"}): ${msg}`);
      this._view.webview.postMessage({
        type: "error",
        value: `❌ **Error${status ? ` (${status})` : ""}:** ${msg}`,
      });
    } finally {
      this.abortController = undefined;
    }
  }

  // ── HTML ───────────────────────────────────────────────────────────────────
  private getHtmlForWebview() {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CodePartner</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    :root {
      --radius: 10px;
      --radius-sm: 6px;
      --gap: 14px;
    }

    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground);
    }

    /* ── Header ── */
    #header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    #header-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      opacity: 0.8;
    }

    #header-title svg {
      width: 14px;
      height: 14px;
      fill: var(--vscode-button-background);
    }

    #clear-btn {
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      opacity: 0.5;
      cursor: pointer;
      padding: 3px 6px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 5px;
      transition: opacity 0.2s, background 0.2s;
    }
    #clear-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    #clear-btn svg { width: 12px; height: 12px; fill: currentColor; }

    /* ── Chat history — THE key fix: flex child with min-height:0 ── */
    #chat-history {
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: var(--gap);
      display: flex;
      flex-direction: column;
      gap: var(--gap);
      scroll-behavior: smooth;
    }

    /* ── Messages ── */
    .message {
      padding: 10px 14px;
      border-radius: var(--radius);
      max-width: 96%;
      word-wrap: break-word;
      overflow-wrap: anywhere;
      line-height: 1.55;
      font-size: 13px;
      animation: fadeIn 0.18s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-bottom-right-radius: 3px;
    }

    .assistant {
      align-self: flex-start;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-bottom-left-radius: 3px;
      width: 100%;
      overflow: hidden;
    }

    .error-msg {
      align-self: stretch;
      background: transparent;
      border: 1px solid var(--vscode-errorForeground);
      color: var(--vscode-errorForeground);
      font-size: 12px;
      border-radius: var(--radius-sm);
    }

    /* ── Markdown inside .assistant ── */
    .assistant p { margin: 0 0 8px; }
    .assistant p:last-child { margin-bottom: 0; }
    .assistant ul, .assistant ol { margin: 6px 0 8px 18px; padding: 0; }
    .assistant li { margin-bottom: 3px; }
    .assistant h1,.assistant h2,.assistant h3 {
      margin: 10px 0 6px;
      font-size: 13px;
      font-weight: 700;
    }
    .assistant a { color: var(--vscode-textLink-foreground); }
    .assistant blockquote {
      margin: 6px 0;
      padding: 4px 10px;
      border-left: 3px solid var(--vscode-button-background);
      opacity: 0.8;
    }
    .assistant table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
    .assistant th, .assistant td {
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 8px;
      text-align: left;
    }
    .assistant th { background: var(--vscode-editorGroupHeader-tabsBackground); }

    /* inline code */
    :not(pre) > code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 5px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 12px;
      color: var(--vscode-symbolIcon-variableForeground);
    }

    /* ── Code block wrapper ── */
    .code-block-wrapper {
      margin: 10px 0;
      border-radius: var(--radius-sm);
      border: 1px solid var(--vscode-widget-border);
      background: var(--vscode-textCodeBlock-background);
      overflow: hidden;
    }

    .code-block-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-widget-border);
    }

    .code-lang {
      font-size: 10px;
      opacity: 0.55;
      font-family: var(--vscode-editor-font-family, monospace);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .code-actions { display: flex; gap: 4px; }

    .code-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid transparent;
      padding: 2px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      opacity: 0.75;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .code-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      border-color: var(--vscode-toolbar-hoverOutline, transparent);
      opacity: 1;
    }
    .code-btn svg { width: 11px; height: 11px; fill: currentColor; flex-shrink: 0; }

    .assistant pre {
      margin: 0;
      padding: 12px;
      overflow-x: auto;
      background: transparent;
    }

    .assistant code {
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 12px;
    }

    /* ── Typing indicator ── */
    .typing-indicator {
      display: inline-flex;
      gap: 4px;
      align-items: center;
      padding: 2px 0;
    }
    .typing-indicator span {
      width: 6px; height: 6px;
      background: var(--vscode-foreground);
      border-radius: 50%;
      opacity: 0.35;
      animation: bounce 1.3s infinite ease-in-out;
    }
    .typing-indicator span:nth-child(2) { animation-delay: 0.18s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes bounce {
      0%,100% { transform: translateY(0); opacity: 0.35; }
      50%      { transform: translateY(-4px); opacity: 0.9; }
    }

    /* ── Input area ── */
    #input-container {
      flex-shrink: 0;
      padding: 10px 12px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    #status-text {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      min-height: 13px;
      opacity: 0.7;
      padding-left: 2px;
    }

    .input-row {
      display: flex;
      align-items: flex-end;
      gap: 6px;
    }

    .input-wrapper {
      flex: 1;
      display: flex;
      align-items: flex-end;
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--radius-sm);
      background: var(--vscode-input-background);
      transition: border-color 0.18s;
      overflow: hidden;
    }
    .input-wrapper:focus-within { border-color: var(--vscode-focusBorder); }

    textarea {
      flex: 1;
      background: transparent;
      color: var(--vscode-input-foreground);
      border: none;
      padding: 8px 10px;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      resize: none;
      min-height: 36px;
      max-height: 160px;
      outline: none;
      line-height: 1.5;
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }

    #send-btn {
      flex-shrink: 0;
      width: 34px;
      height: 34px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: opacity 0.15s;
    }
    #send-btn:hover { opacity: 0.85; }
    #send-btn.stop { background: var(--vscode-errorForeground); }
    #send-btn svg { width: 15px; height: 15px; fill: currentColor; }

    /* ── Quick-insert tag hints ── */
    .tag-hints {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .tag-hint {
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 12px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      cursor: pointer;
      opacity: 0.75;
      transition: opacity 0.15s;
      user-select: none;
    }
    .tag-hint:hover { opacity: 1; }
  </style>
</head>
<body>

  <div id="header">
    <div id="header-title">
      <svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2a5 5 0 1 1 0 10A5 5 0 0 1 8 3zm-.5 2v3.25l2.6 1.5.5-.87L8.5 7.5V5h-1z"/></svg>
      CodePartner
    </div>
    <button id="clear-btn" title="Clear conversation">
      <svg viewBox="0 0 16 16"><path d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM9 2H6v1h3V2zM4 13h7V4H4v9zm2-8H5v7h1V5zm2 0H7v7h1V5zm2 0H9v7h1V5z"/></svg>
      Clear
    </button>
  </div>

  <div id="chat-history">
    <div class="message assistant">
      <strong>👋 Hello! I'm CodePartner.</strong>
      <p style="margin:8px 0 6px;">Use these tags in any message:</p>
      <ul style="margin:0;padding-left:18px;">
        <li><code>@web &lt;query&gt;</code> — search the internet</li>
        <li><code>@workspace</code> — include repo structure</li>
        <li><code>@filename</code> — inject a file's contents</li>
      </ul>
      <p style="margin:8px 0 0;">I automatically read your active file &amp; selection!</p>
    </div>
  </div>

  <div id="input-container">
    <div id="status-text"></div>
    <div class="input-row">
      <div class="input-wrapper">
        <textarea id="prompt-input" rows="1" placeholder="Ask anything… (@web, @workspace, @file)"></textarea>
      </div>
      <button id="send-btn" title="Send (Enter)">
        <svg viewBox="0 0 16 16"><path d="M1.724 1.053a.5.5 0 0 0-.714.545l1.403 4.85a.5.5 0 0 0 .397.354l5.69.953c.268.053.268.437 0 .49l-5.69.953a.5.5 0 0 0-.397.354l-1.403 4.85a.5.5 0 0 0 .714.545l13-6.5a.5.5 0 0 0 0-.894l-13-6.5Z"/></svg>
      </button>
    </div>
    <div class="tag-hints">
      <span class="tag-hint" onclick="insertTag('@web ')">@web</span>
      <span class="tag-hint" onclick="insertTag('@workspace')">@workspace</span>
      <span class="tag-hint" onclick="insertTag('@')">@file</span>
    </div>
  </div>

  <script>
    const vscode       = acquireVsCodeApi();
    const chatHistory  = document.getElementById('chat-history');
    const promptInput  = document.getElementById('prompt-input');
    const sendBtn      = document.getElementById('send-btn');
    const statusText   = document.getElementById('status-text');
    const clearBtn     = document.getElementById('clear-btn');

    let currentDiv = null;
    let isWaiting  = false;

    const SEND_ICON = '<svg viewBox="0 0 16 16"><path d="M1.724 1.053a.5.5 0 0 0-.714.545l1.403 4.85a.5.5 0 0 0 .397.354l5.69.953c.268.053.268.437 0 .49l-5.69.953a.5.5 0 0 0-.397.354l-1.403 4.85a.5.5 0 0 0 .714.545l13-6.5a.5.5 0 0 0 0-.894l-13-6.5Z"/></svg>';
    const STOP_ICON = '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>';

    function insertTag(tag) {
      const pos = promptInput.selectionStart;
      const val = promptInput.value;
      promptInput.value = val.slice(0, pos) + tag + val.slice(pos);
      promptInput.focus();
      promptInput.selectionStart = promptInput.selectionEnd = pos + tag.length;
    }

    // Auto-grow textarea
    promptInput.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 160) + 'px';
    });

    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
    });

    sendBtn.addEventListener('click', () => {
      if (isWaiting) {
        vscode.postMessage({ type: 'cancel' });
        setWaiting(false);
        if (currentDiv) {
          currentDiv.innerHTML += '<br><em style="opacity:.5;font-size:11px">(cancelled)</em>';
          processCodeBlocks(currentDiv);
          currentDiv = null;
        }
      } else {
        sendPrompt();
      }
    });

    clearBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearChat' });
      while (chatHistory.children.length > 1) chatHistory.removeChild(chatHistory.lastChild);
    });

    function setWaiting(waiting) {
      isWaiting = waiting;
      sendBtn.innerHTML = waiting ? STOP_ICON : SEND_ICON;
      sendBtn.classList.toggle('stop', waiting);
      if (!waiting) statusText.innerText = '';
    }

    function sendPrompt() {
      const text = promptInput.value.trim();
      if (!text || isWaiting) return;

      const userDiv = document.createElement('div');
      userDiv.className = 'message user';
      userDiv.textContent = text;
      chatHistory.appendChild(userDiv);

      promptInput.value = '';
      promptInput.style.height = 'auto';
      setWaiting(true);

      currentDiv = document.createElement('div');
      currentDiv.className = 'message assistant';
      currentDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
      chatHistory.appendChild(currentDiv);
      scrollBottom();

      vscode.postMessage({ type: 'prompt', value: text });
    }

    // ── Code block enhancement ──────────────────────────────────────────────
    function getLang(pre) {
      const code = pre.querySelector('code');
      if (!code) return '';
      const cls = [...code.classList].find(c => c.startsWith('language-'));
      return cls ? cls.replace('language-', '') : '';
    }

    function processCodeBlocks(container) {
      container.querySelectorAll('pre:not([data-cp])').forEach(pre => {
        pre.setAttribute('data-cp', '1');

        const lang    = getLang(pre);
        const rawCode = () => (pre.querySelector('code') || pre).innerText;

        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';

        const header = document.createElement('div');
        header.className = 'code-block-header';

        const langSpan = document.createElement('span');
        langSpan.className = 'code-lang';
        langSpan.textContent = lang || 'code';

        const actions = document.createElement('div');
        actions.className = 'code-actions';

        // Copy
        const copyBtn = makeBtn(
          '<svg viewBox="0 0 16 16"><path d="M4 4h8v1H4V4zm0 2h8v1H4V6zm0 2h5v1H4V8zm8-7H3L2 2v11l1 1h4v-1H3V2h8v1h1V2l-1-1zm2 4h-7l-1 1v8l1 1h7l1-1V6l-1-1zm0 9H6V6h7v9z"/></svg>',
          'Copy', 'copy-lbl'
        );
        copyBtn.onclick = () => {
          vscode.postMessage({ type: 'copyCode', value: rawCode() });
          copyBtn.querySelector('.copy-lbl').textContent = 'Copied!';
          setTimeout(() => copyBtn.querySelector('.copy-lbl').textContent = 'Copy', 1500);
        };

        // Insert
        const insertBtn = makeBtn(
          '<svg viewBox="0 0 16 16"><path d="M1 2h2v2H1V2zm0 4h2v2H1V6zm0 4h2v2H1v-2zm4-8h10v2H5V2zm0 4h10v2H5V6zm0 4h6v2H5v-2z"/></svg>',
          'Insert', null
        );
        insertBtn.onclick = () => vscode.postMessage({ type: 'insertCode', value: rawCode() });

        // Diff
        const diffBtn = makeBtn(
          '<svg viewBox="0 0 16 16"><path d="M6 3h4v2H6V3zm0 4h4v2H6V7zm0 4h4v2H6v-2zM2 3h3v2H2V3zm0 4h3v2H2V7zm0 4h3v2H2v-2zm9 0h3v2h-3v-2zm0-4h3v2h-3V7zm0-4h3v2h-3V3z"/></svg>',
          'Diff', null
        );
        diffBtn.onclick = () => vscode.postMessage({ type: 'applyDiff', value: rawCode() });

        actions.append(copyBtn, insertBtn, diffBtn);
        header.append(langSpan, actions);

        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(header);
        wrapper.appendChild(pre);
      });
    }

    function makeBtn(iconSvg, label, labelClass) {
      const btn = document.createElement('button');
      btn.className = 'code-btn';
      const cls = labelClass ? \` class="\${labelClass}"\` : '';
      btn.innerHTML = iconSvg + \`<span\${cls}>\${label}</span>\`;
      return btn;
    }

    // ── Message handling ────────────────────────────────────────────────────
    window.addEventListener('message', ({ data: msg }) => {
      switch (msg.type) {
        case 'status':
          statusText.innerText = msg.value;
          break;

        case 'partial':
          if (currentDiv) {
            currentDiv.innerHTML = msg.value;
            processCodeBlocks(currentDiv);
            scrollBottom();
          }
          break;

        case 'done':
          setWaiting(false);
          if (currentDiv) { processCodeBlocks(currentDiv); currentDiv = null; }
          break;

        case 'error':
          setWaiting(false);
          const target = currentDiv || (() => {
            const d = document.createElement('div');
            chatHistory.appendChild(d);
            return d;
          })();
          target.innerHTML = msg.value;
          target.className = 'message error-msg';
          currentDiv = null;
          scrollBottom();
          break;
      }
    });

    function scrollBottom() {
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }
  </script>
</body>
</html>`;
  }
}