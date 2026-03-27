import * as vscode from "vscode";
import axios from "axios";
import { createParser } from "eventsource-parser";
import MarkdownIt = require("markdown-it");
import * as path from "path";

const md = new MarkdownIt();

// Custom TextDocumentContentProvider for our Git-style diff view
class CodePartnerDiffProvider implements vscode.TextDocumentContentProvider {
  public static scheme = 'codepartner-diff';
  private _content: string = "";

  // Emitter to notify VS Code when the content changes
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this._content;
  }

  update(content: string) {
    this._content = content;
    // Notify all listeners that any URI under this scheme has changed
    this._onDidChange.fire(vscode.Uri.parse(`${CodePartnerDiffProvider.scheme}:Proposed_Change`));
  }
}

const diffProvider = new CodePartnerDiffProvider();

const SYSTEM_PROMPT = `You are CodePartner, an expert AI coding assistant embedded in VS Code.
You help users write, debug, refactor, and understand code.
Always respond with clear, concise explanations and well-formatted code blocks.
When showing code, always specify the language in the code fence.
If the user shares code context or searches the web/workspace, analyze it completely. Provide exactly what they need.`;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("CodePartner");
  context.subscriptions.push(output);
  output.appendLine("CodePartner extension activated.");

  // Register our diff provider
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(CodePartnerDiffProvider.scheme, diffProvider)
  );

  const provider = new CodePartnerSidebarProvider(context.extensionUri, output);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codepartner-sidebar", provider)
  );
}

export function deactivate() {}

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
    context: vscode.WebviewViewResolveContext,
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
        case "prompt": {
          this.handlePrompt(data.value);
          break;
        }
        case "cancel": {
          if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
            this.output.appendLine("[CodePartner] Request cancelled by user.");
          }
          break;
        }
        case "applyDiff": {
          this.applyDiffToEditor(data.value);
          break;
        }
      }
    });
  }

  private async applyDiffToEditor(aiCode: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("CodePartner: Open a file to apply a diff comparing changes.");
      return;
    }

    const document = editor.document;
    const selection = editor.selection;
    
    // We will compare the entire file
    // But we need to logically replace the selection (if any) with aiCode 
    // to build the "Proposed" file content.
    let proposedFullContent = "";
    
    if (!selection.isEmpty) {
      // Replace only the selection with AI code
      const textBefore = document.getText(new vscode.Range(new vscode.Position(0,0), selection.start));
      const textAfter = document.getText(new vscode.Range(selection.end, document.lineAt(document.lineCount - 1).range.end));
      proposedFullContent = textBefore + aiCode + textAfter;
    } else {
      // If no selection, assume the AI code is a full file rewrite, OR just append it.
      // Usually, if there's no selection, we show a diff of the whole file replaced.
      proposedFullContent = aiCode;
    }

    // Update the diff provider's content
    diffProvider.update(proposedFullContent);

    // Build the URIs
    const originalUri = document.uri;
    const ext = path.extname(document.fileName) || '.txt';
    const proposedUri = vscode.Uri.parse(`${CodePartnerDiffProvider.scheme}:Proposed_Change${ext}`);

    // Open native diff
    vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      'CodePartner: Review Changes'
    );
  }

  // Parses @filename and returns file contents
  private async getFileMentionsContext(prompt: string): Promise<string> {
    const mentionRegex = /@([a-zA-Z0-9_\-./\\]+)/g;
    let match;
    let context = "";
    const seenFiles = new Set<string>();

    while ((match = mentionRegex.exec(prompt)) !== null) {
      const filename = match[1];
      if (filename === "web" || filename === "workspace") continue; // Special tags

      if (!seenFiles.has(filename)) {
        seenFiles.add(filename);
        try {
          // Find files matching this name exactly or partially
          const files = await vscode.workspace.findFiles(`**/${filename}`, '{**/node_modules/**,**/.git/**,**/dist/**}', 1);
          if (files.length > 0) {
            const document = await vscode.workspace.openTextDocument(files[0]);
            context += `\n--- Extracted File: ${filename} ---\n\`\`\`\n${document.getText()}\n\`\`\`\n\n`;
            this.output.appendLine(`[CodePartner] Included @ mention file: ${filename}`);
          } else {
             // Fallback: try globbing it if it was a partial path
             const fallbackFiles = await vscode.workspace.findFiles(`**/*${filename}*`, '{**/node_modules/**,**/dist/**}', 1);
             if (fallbackFiles.length > 0) {
                const document = await vscode.workspace.openTextDocument(fallbackFiles[0]);
                context += `\n--- Extracted File: ${vscode.workspace.asRelativePath(fallbackFiles[0])} ---\n\`\`\`\n${document.getText()}\n\`\`\`\n\n`;
             }
          }
        } catch (e) {
          this.output.appendLine(`[CodePartner] Could not read file mention: ${filename}`);
        }
      }
    }
    return context;
  }

  // Performs a DuckDuckGo HTML search and extracts top snippets
  private async getWebSearchContext(prompt: string): Promise<string> {
    if (!prompt.includes("@web")) return "";

    const queryMatch = prompt.match(/@web\s+(.*)/i);
    const query = queryMatch ? queryMatch[1] : prompt.replace("@web", "").trim();
    
    if (!query) return "";
    
    this._view?.webview.postMessage({ type: 'status', value: 'Searching the web...' });

    try {
      this.output.appendLine(`[CodePartner] Searching web for: ${query}`);
      const res = await axios.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      
      const html = res.data as string;
      const snippets: string[] = [];
      
      // Extremely lightweight regex extraction of DDG results (result__snippet classes)
      const snippetRegex = /<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      let count = 0;
      while ((match = snippetRegex.exec(html)) !== null && count < 3) {
        // Strip HTML tags from inner content
        const rawText = match[1].replace(/<[^>]+>/g, "").trim();
        snippets.push(rawText);
        count++;
      }

      if (snippets.length > 0) {
        return `\n--- Web Search Results for "${query}" ---\n` + snippets.map((s, i) => `${i+1}. ${s}`).join("\n\n") + "\n\n";
      }
    } catch (e: any) {
      this.output.appendLine(`[CodePartner] Web search failed: ${e.message}`);
    }

    return "\n--- Web Search Failed ---\nNo results could be fetched.\n\n";
  }

  // Gets a structural overview of the workspace
  private async getWorkspaceContext(prompt: string): Promise<string> {
    if (!prompt.includes("@workspace")) return "";
    
    this._view?.webview.postMessage({ type: 'status', value: 'Scanning workspace...' });
    
    try {
      const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}', 200);
      const paths = files.map(f => vscode.workspace.asRelativePath(f)).sort();
      
      return `\n--- Workspace Structure (${paths.length} files) ---\n` + paths.join("\n") + "\n\n";
    } catch (e) {
      return "";
    }
  }

  private async handlePrompt(prompt: string) {
    if (!this._view) return;

    this._view.webview.postMessage({ type: 'status', value: 'Preparing context...' });

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
        value: "⚠️ **CodePartner is not configured.**\n\nOpen **Settings** and set:\n- `codepartner.provider`\n- `codepartner.apiEndpoint`\n- `codepartner.apiKey`\n- `codepartner.model`",
      });
      return;
    }

    // --- CONTEXT INJECTION PIPELINE ---
    let contextHeader = "";

    // 1. @website / web search
    contextHeader += await this.getWebSearchContext(prompt);

    // 2. @workspace structural search
    contextHeader += await this.getWorkspaceContext(prompt);

    // 3. @filename mentions
    contextHeader += await this.getFileMentionsContext(prompt);

    // 4. Active Editor Context
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const document = editor.document;
      const selection = editor.selection;
      const fileName = document.fileName.split(/[/\\]/).pop();

      let codeContext = "";
      if (!selection.isEmpty) {
        codeContext = document.getText(selection);
        contextHeader += `\n--- Context ---\nActive File: \`${fileName}\`\nSelected Code (Target of Prompt):\n\`\`\`\n${codeContext}\n\`\`\`\n`;
      } else {
        const text = document.getText();
        const cappedText = text.length > 8000 ? text.substring(0, 8000) + "\n... (truncated)" : text;
        contextHeader += `\n--- Context ---\nActive File: \`${fileName}\`\nContent:\n\`\`\`\n${cappedText}\n\`\`\`\n`;
      }
    }

    const finalPrompt = contextHeader.length > 0 
      ? `${contextHeader}\n\nUser Question:\n${prompt}` 
      : prompt;
    // ----------------------------------

    this.messageHistory.push({ role: "user", content: finalPrompt });

    let url = "";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Fixed replace regex syntax error
    const endpoint = apiEndpoint.replace(/\/$/, "");

    if (providerType === "azure") {
      url = `${endpoint}/openai/deployments/${modelId}/chat/completions?api-version=${azureApiVersion}`;
      headers["api-key"] = apiKey;
    } else {
      url = `${endpoint}/chat/completions`;
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const body: Record<string, unknown> = {
      messages: this.messageHistory.map(msg => ({ role: msg.role, content: msg.content })),
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: true,
    };

    if (providerType !== "azure") {
      body.model = modelId;
    }

    this.output.appendLine(`[CodePartner] POST → ${url}`);
    this._view.webview.postMessage({ type: 'status', value: 'Thinking...' });

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
          const data = event.data;
          if (data === "[DONE]") return;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content ?? "";
            if (content) {
              fullResponse += content;
              this._view?.webview.postMessage({
                type: "partial",
                value: md.render(fullResponse),
              });
            }
          } catch {
            // Ignore malformed JSON
          }
        },
      });

      await new Promise<void>((resolve, reject) => {
        response.data.on("data", (chunk: Buffer) => {
          parser.feed(chunk.toString("utf8"));
        });
        response.data.on("end", resolve);
        response.data.on("error", reject);
      });

      if (fullResponse) {
        this.messageHistory.push({ role: "assistant", content: fullResponse });
      }

      this._view.webview.postMessage({ type: "done" });
      this.output.appendLine("[CodePartner] Request completed.");
    } catch (err: any) {
      if (axios.isCancel(err) || err.name === 'CanceledError') {
        return;
      }

      const status = err?.response?.status;
      const apiMsg = err?.response?.data?.error?.message || "";
      const msg = apiMsg || err?.message || String(err);

      this.output.appendLine(`[CodePartner] Error (${status ?? "?"}): ${msg}`);
      
      this._view.webview.postMessage({
        type: "error",
        value: `❌ **Error${status ? ` (${status})` : ""}:** ${msg}`,
      });
    } finally {
      this.abortController = undefined;
    }
  }

  private getHtmlForWebview() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodePartner Chat</title>
  <style>
    :root {
      --chat-radius: 8px;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden; /* Prevent body scrollbar! */
    }
    
    /* Scrollbar Polish */
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground);
    }
    ::-webkit-scrollbar-thumb:active {
      background: var(--vscode-scrollbarSlider-activeBackground);
    }

    #chat-history {
      flex: 1;
      overflow-y: overlay; /* Native-like overlay scrollbar */
      overflow-x: hidden;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    
    .message {
      padding: 10px 14px;
      border-radius: var(--chat-radius);
      max-width: 92%;
      word-wrap: break-word;
      line-height: 1.5;
      font-size: 13px;
      position: relative;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    
    .user {
      align-self: flex-end;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-bottom-right-radius: 2px;
    }
    
    .assistant {
      align-self: flex-start;
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-bottom-left-radius: 2px;
      width: 100%;
      overflow-x: hidden;
    }
    
    /* Markdown Styles */
    .assistant p { margin: 0 0 10px 0; }
    .assistant p:last-child { margin-bottom: 0; }
    .assistant a { color: var(--vscode-textLink-foreground); }

    /* CODE BLOCKS WITH BUTTONS */
    .code-block-wrapper {
      margin: 12px 0;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--vscode-widget-border);
      background-color: var(--vscode-textCodeBlock-background);
    }
    
    .code-block-header {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      padding: 4px 8px;
      background-color: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-widget-border);
      font-size: 11px;
    }
    
    .code-block-header button {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid transparent;
      padding: 3px 8px;
      border-radius: 3px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      opacity: 0.8;
      transition: all 0.2s;
    }
    
    .code-block-header button:hover {
      background-color: var(--vscode-toolbar-hoverBackground);
      border: 1px solid var(--vscode-toolbar-hoverOutline);
      opacity: 1;
    }
    
    .code-block-header button svg {
      width: 12px;
      height: 12px;
    }

    .assistant pre {
      margin: 0;
      padding: 12px;
      overflow-x: auto;
    }
    
    .assistant code {
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 12px;
    }
    
    /* Inline code */
    :not(pre) > code {
      background-color: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 12px;
      color: var(--vscode-symbolIcon-variableForeground);
    }

    .error {
      align-self: center;
      color: var(--vscode-errorForeground);
      border: 1px solid var(--vscode-errorForeground);
      background-color: transparent;
      box-shadow: none;
    }

    /* Input Area */
    #input-container {
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background-color: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    .input-wrapper {
      position: relative;
      display: flex;
      align-items: flex-end;
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      background-color: var(--vscode-input-background);
      transition: border-color 0.2s;
    }
    
    .input-wrapper:focus-within {
      border-color: var(--vscode-focusBorder);
    }
    
    textarea {
      flex: 1;
      background: transparent;
      color: var(--vscode-input-foreground);
      border: none;
      padding: 10px;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      resize: none;
      min-height: 20px;
      max-height: 200px;
      outline: none;
    }
    
    textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    
    #send-btn {
      background: transparent;
      color: var(--vscode-button-background);
      border: none;
      padding: 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
    }
    
    #send-btn:hover {
      background-color: var(--vscode-toolbar-hoverBackground);
    }

    #send-btn svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
    
    #send-btn.stop {
      color: var(--vscode-errorForeground);
    }

    /* Status text underneath textarea */
    #status-text {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      min-height: 12px;
      opacity: 0.7;
    }

    /* Loading dots */
    .typing-indicator {
      display: inline-flex;
      gap: 4px;
      align-items: center;
      height: 20px;
    }
    .typing-indicator span {
      width: 6px;
      height: 6px;
      background-color: var(--vscode-foreground);
      border-radius: 50%;
      opacity: 0.4;
      animation: pulse 1.4s infinite;
    }
    .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
    
    @keyframes pulse {
      0%, 100% { opacity: 0.4; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.2); }
    }
  </style>
</head>
<body>

  <div id="chat-history">
    <div class="message assistant">
      <p>Hello! I am CodePartner.</p>
      <ul>
        <li><strong>@filename</strong> to inject a file</li>
        <li><strong>@workspace</strong> to search repo structure</li>
        <li><strong>@web</strong> to hit the internet</li>
      </ul>
      <p>I automatically read your active file and highlighted code!</p>
    </div>
  </div>

  <div id="input-container">
    <div id="status-text"></div>
    <div class="input-wrapper">
      <textarea id="prompt-input" rows="1" placeholder="Ask CodePartner... (@web, @workspace, @file)"></textarea>
      <button id="send-btn" title="Send (Enter)">
        <svg viewBox="0 0 16 16"><path d="M1.724 1.053a.5.5 0 0 0-.714.545l1.403 4.85a.5.5 0 0 0 .397.354l5.69.953c.268.053.268.437 0 .49l-5.69.953a.5.5 0 0 0-.397.354l-1.403 4.85a.5.5 0 0 0 .714.545l13-6.5a.5.5 0 0 0 0-.894l-13-6.5Z"/></svg>
      </button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const chatHistory = document.getElementById('chat-history');
    const promptInput = document.getElementById('prompt-input');
    const sendBtn = document.getElementById('send-btn');
    const statusText = document.getElementById('status-text');
    
    let currentAssistantDiv = null;
    let isWaiting = false;

    const sendIcon = '<svg viewBox="0 0 16 16"><path d="M1.724 1.053a.5.5 0 0 0-.714.545l1.403 4.85a.5.5 0 0 0 .397.354l5.69.953c.268.053.268.437 0 .49l-5.69.953a.5.5 0 0 0-.397.354l-1.403 4.85a.5.5 0 0 0 .714.545l13-6.5a.5.5 0 0 0 0-.894l-13-6.5Z"/></svg>';
    const stopIcon = '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>';

    promptInput.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = (this.scrollHeight) + 'px';
    });

    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
    });

    sendBtn.addEventListener('click', (e) => {
      if (isWaiting) {
        vscode.postMessage({ type: 'cancel' });
        setWaitingState(false);
        if (currentAssistantDiv) {
          currentAssistantDiv.innerHTML += '<br><br><em style="opacity:0.6;">(Cancelled)</em>';
          processCodeBlocks(currentAssistantDiv);
          currentAssistantDiv = null;
        }
      } else {
        sendPrompt();
      }
    });

    function setWaitingState(waiting) {
      isWaiting = waiting;
      if (waiting) {
        sendBtn.innerHTML = stopIcon;
        sendBtn.classList.add('stop');
      } else {
        sendBtn.innerHTML = sendIcon;
        sendBtn.classList.remove('stop');
        statusText.innerText = '';
      }
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
      
      setWaitingState(true);
      
      currentAssistantDiv = document.createElement('div');
      currentAssistantDiv.className = 'message assistant';
      currentAssistantDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
      chatHistory.appendChild(currentAssistantDiv);
      scrollToBottom();

      vscode.postMessage({ type: 'prompt', value: text });
    }

    function processCodeBlocks(container) {
      const pres = container.querySelectorAll('pre:not(.processed)');
      pres.forEach(pre => {
        pre.classList.add('processed');
        
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';
        
        const header = document.createElement('div');
        header.className = 'code-block-header';
        
        const insertBtn = document.createElement('button');
        insertBtn.innerHTML = '<svg fill="currentColor" viewBox="0 0 16 16"><path d="m14.53 4.53-3-3-.53-.22L1 3.22V15h14V5l-.47-.47zM11 2.56l2.44 2.44H11V2.56zM2 14v-9.7l8 1.94V6.5l3.52 3.52L14 14H2z"/><path d="m13.03 10.47-2-2L10 8.5l-3.5 3.5.53.53L9.5 9.06l1.47 1.47V7.5h-3l2.03 2.03-3.6 3.6.53.53 3.6-3.6z"/></svg> Apply Diff';
        insertBtn.onclick = () => {
          const code = pre.querySelector('code')?.innerText || pre.innerText;
          vscode.postMessage({ type: 'applyDiff', value: code });
        };
        
        header.appendChild(insertBtn);
        
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(header);
        wrapper.appendChild(pre);
      });
    }

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'status':
          statusText.innerText = message.value;
          break;
        case 'partial':
          if (currentAssistantDiv) {
            currentAssistantDiv.innerHTML = message.value;
            processCodeBlocks(currentAssistantDiv); 
            scrollToBottom();
          }
          break;
        case 'done':
          setWaitingState(false);
          if (currentAssistantDiv) {
            processCodeBlocks(currentAssistantDiv);
          }
          currentAssistantDiv = null;
          break;
        case 'error':
          if (currentAssistantDiv) {
            currentAssistantDiv.innerHTML = message.value;
            currentAssistantDiv.classList.add('error');
          }
          setWaitingState(false);
          currentAssistantDiv = null;
          scrollToBottom();
          break;
      }
    });

    function scrollToBottom() {
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }
  </script>
</body>
</html>`;
  }
}
