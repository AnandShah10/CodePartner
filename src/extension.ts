import * as vscode from "vscode";
import axios from "axios";
import { createParser } from "eventsource-parser";
import MarkdownIt = require("markdown-it");

const md = new MarkdownIt();

// Custom markdown-it rules to style codeblocks later if needed, but we will handle button injection via client-side DOM.

const SYSTEM_PROMPT = `You are CodePartner, an expert AI coding assistant embedded in VS Code.
You help users write, debug, refactor, and understand code.
Always respond with clear, concise explanations and well-formatted code blocks.
When showing code, always specify the language in the code fence.
If the user shares code context, analyze it completely. Provide exactly what they need.`;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("CodePartner");
  context.subscriptions.push(output);
  output.appendLine("CodePartner extension activated.");

  const provider = new CodePartnerSidebarProvider(context.extensionUri, output);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codepartner-sidebar", provider)
  );

  // Keep the diagnostic command around for debugging
  const helloCmd = vscode.commands.registerCommand("codepartner.helloWorld", async () => {
    vscode.window.showInformationMessage("CodePartner: Running test command!");
    // (Command logic omitted to keep this lean, API test logic here if needed)
  });
  context.subscriptions.push(helloCmd);
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
        case "insertCode": {
          this.insertCodeIntoEditor(data.value);
          break;
        }
      }
    });
  }

  private async insertCodeIntoEditor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("CodePartner: Open a file to insert code.");
      return;
    }

    const selection = editor.selection;
    editor.edit((editBuilder) => {
      // If there's a selection, replace it. Otherwise, insert at the cursor.
      if (!selection.isEmpty) {
        editBuilder.replace(selection, code);
      } else {
        editBuilder.insert(selection.active, code);
      }
    });
  }

  private async handlePrompt(prompt: string) {
    if (!this._view) return;

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
    const editor = vscode.window.activeTextEditor;
    let contextHeader = "";
    
    if (editor) {
      const document = editor.document;
      const selection = editor.selection;
      const fileName = document.fileName.split(/[/\\]/).pop();

      // Prioritize highlighted text context. If none, grab some surrounding context or whole file if short.
      let codeContext = "";
      if (!selection.isEmpty) {
        codeContext = document.getText(selection);
        contextHeader = `\n\n--- Context ---\nFile: \`${fileName}\`\nSelected Code:\n\`\`\`\n${codeContext}\n\`\`\``;
      } else {
        // Just the file content (capped to avoid blowing up tokens)
        const text = document.getText();
        const cappedText = text.length > 5000 ? text.substring(0, 5000) + "\n... (truncated)" : text;
        contextHeader = `\n\n--- Context ---\nActive File: \`${fileName}\`\nContent:\n\`\`\`\n${cappedText}\n\`\`\``;
      }
    }

    const finalPrompt = prompt + contextHeader;
    // ----------------------------------

    // Add user message to history
    this.messageHistory.push({ role: "user", content: finalPrompt });

    let url = "";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const endpoint = apiEndpoint.replace(/\/$/, "");

    if (providerType === "azure") {
      url = `${endpoint}/openai/deployments/${modelId}/chat/completions?api-version=${azureApiVersion}`;
      headers["api-key"] = apiKey;
    } else {
      url = `${endpoint}/chat/completions`;
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const body: Record<string, unknown> = {
      messages: this.messageHistory.map(msg => ({ role: msg.role, content: msg.content })), // strip any extra keys
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: true,
    };

    if (providerType !== "azure") {
      body.model = modelId;
    }

    this.output.appendLine(`[CodePartner] POST → ${url}`);

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
      overflow: hidden;
    }
    
    /* Scrollbar Polish */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground);
    }
    ::-webkit-scrollbar-thumb:active {
      background: var(--vscode-scrollbarSlider-activeBackground);
    }

    #chat-history {
      flex: 1;
      overflow-y: auto;
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
    .assistant p {
      margin: 0 0 10px 0;
    }
    .assistant p:last-child {
      margin-bottom: 0;
    }
    .assistant a {
      color: var(--vscode-textLink-foreground);
    }

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
      border: none;
      padding: 4px 8px;
      border-radius: 3px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      opacity: 0.8;
      transition: all 0.2s;
    }
    
    .code-block-header button:hover {
      background-color: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
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
      <p>I will automatically read the file you have open, and specifically any code you have highlighted, to give you perfectly contextual answers.</p>
    </div>
  </div>

  <div id="input-container">
    <div class="input-wrapper">
      <textarea id="prompt-input" rows="1" placeholder="Ask CodePartner... (Shift+Enter for newline)"></textarea>
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
    
    let currentAssistantDiv = null;
    let isWaiting = false;

    // Send Icon SVG
    const sendIcon = \`<svg viewBox="0 0 16 16"><path d="M1.724 1.053a.5.5 0 0 0-.714.545l1.403 4.85a.5.5 0 0 0 .397.354l5.69.953c.268.053.268.437 0 .49l-5.69.953a.5.5 0 0 0-.397.354l-1.403 4.85a.5.5 0 0 0 .714.545l13-6.5a.5.5 0 0 0 0-.894l-13-6.5Z"/></svg>\`;
    
    // Stop Icon SVG
    const stopIcon = \`<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>\`;

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
          processCodeBlocks(currentAssistantDiv); // One final pass to wrap pre tags
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

    // Wrap raw <pre> tags with our custom header and action buttons
    function processCodeBlocks(container) {
      const pres = container.querySelectorAll('pre:not(.processed)');
      pres.forEach(pre => {
        pre.classList.add('processed');
        
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';
        
        const header = document.createElement('div');
        header.className = 'code-block-header';
        
        const insertBtn = document.createElement('button');
        insertBtn.innerHTML = \`<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M10.5 4v1.5H12V4h-1.5zm-5 0V4H4v1.5h1.5zm2.5 7.5L5.5 9h5l-2.5 2.5z"/></svg> Insert at Cursor\`;
        insertBtn.onclick = () => {
          const code = pre.querySelector('code')?.innerText || pre.innerText;
          vscode.postMessage({ type: 'insertCode', value: code });
          
          const oldHtml = insertBtn.innerHTML;
          insertBtn.innerHTML = '✔ Inserted';
          setTimeout(() => insertBtn.innerHTML = oldHtml, 2000);
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
        case 'partial':
          if (currentAssistantDiv) {
            currentAssistantDiv.innerHTML = message.value;
            // Intermittently process code blocks as they stream in to show buttons early
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
