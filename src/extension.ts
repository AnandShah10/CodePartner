import * as vscode from "vscode";
import axios from "axios";
import { createParser } from "eventsource-parser";
import MarkdownIt = require("markdown-it");

const md = new MarkdownIt();

const SYSTEM_PROMPT = `You are CodePartner, an expert AI coding assistant embedded in VS Code.
You help users write, debug, refactor, and understand code.
Always respond with clear, concise explanations and well-formatted code blocks.
When showing code, always specify the language in the code fence.`;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("CodePartner");
  context.subscriptions.push(output);
  output.appendLine("CodePartner extension activated.");

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
    const maxTokens = config.get<number>("maxTokens") || 1024;

    if (!apiEndpoint || !apiKey || !modelId) {
      this._view.webview.postMessage({
        type: "error",
        value: "⚠️ **CodePartner is not configured.**\n\nOpen **Settings** and set:\n- `codepartner.provider`\n- `codepartner.apiEndpoint`\n- `codepartner.apiKey`\n- `codepartner.model`",
      });
      return;
    }

    // Add user message to history
    this.messageHistory.push({ role: "user", content: prompt });

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
      messages: this.messageHistory,
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
                value: md.render(fullResponse), // render markdown for incremental updates
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

      // Save assistant response to history
      if (fullResponse) {
        this.messageHistory.push({ role: "assistant", content: fullResponse });
      }

      this._view.webview.postMessage({ type: "done" });
      this.output.appendLine("[CodePartner] Request completed.");
    } catch (err: any) {
      if (axios.isCancel(err) || err.name === 'CanceledError') {
        return; // Handled by cancel branch
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
    }
    #chat-history {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .message {
      padding: 8px 12px;
      border-radius: 6px;
      max-width: 90%;
      word-wrap: break-word;
      line-height: 1.4;
    }
    .user {
      align-self: flex-end;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .assistant {
      align-self: flex-start;
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      width: 100%;
      overflow-x: auto;
    }
    .assistant pre {
      background-color: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
    }
    .assistant code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
    }
    .error {
      align-self: center;
      color: var(--vscode-errorForeground);
      font-weight: bold;
      margin-top: 10px;
    }
    #input-container {
      padding: 10px;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 8px;
      background-color: var(--vscode-sideBar-background);
    }
    textarea {
      flex: 1;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      padding: 6px;
      font-family: var(--vscode-font-family);
      resize: none;
      min-height: 24px;
      max-height: 150px;
    }
    textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
      border-color: transparent;
    }
    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      padding: 6px 12px;
      cursor: pointer;
    }
    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>
</head>
<body>

  <div id="chat-history">
    <div class="message assistant">Hello! I am CodePartner. How can I help you?</div>
  </div>

  <div id="input-container">
    <textarea id="prompt-input" rows="1" placeholder="Ask CodePartner... (Shift+Enter for newline)"></textarea>
    <button id="send-btn">Send</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const chatHistory = document.getElementById('chat-history');
    const promptInput = document.getElementById('prompt-input');
    const sendBtn = document.getElementById('send-btn');
    
    let currentAssistantDiv = null;
    let isWaiting = false;

    // Auto-resize textarea
    promptInput.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = (this.scrollHeight) + 'px';
    });

    // Send on Enter (Shift+Enter for newline)
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
    });

    sendBtn.addEventListener('click', sendPrompt);

    function sendPrompt() {
      const text = promptInput.value.trim();
      if (!text || isWaiting) return;

      // Add User Message
      const userDiv = document.createElement('div');
      userDiv.className = 'message user';
      userDiv.textContent = text;
      chatHistory.appendChild(userDiv);

      promptInput.value = '';
      promptInput.style.height = 'auto';
      
      isWaiting = true;
      sendBtn.textContent = 'Stop';
      
      // Prepare Assistant Div
      currentAssistantDiv = document.createElement('div');
      currentAssistantDiv.className = 'message assistant';
      currentAssistantDiv.innerHTML = '<span style="opacity:0.5;">Thinking...</span>';
      chatHistory.appendChild(currentAssistantDiv);
      scrollToBottom();

      vscode.postMessage({ type: 'prompt', value: text });
    }

    // Handle messages from the extension
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'partial':
          if (currentAssistantDiv) {
            currentAssistantDiv.innerHTML = message.value;
            scrollToBottom();
          }
          break;
        case 'done':
          isWaiting = false;
          sendBtn.textContent = 'Send';
          currentAssistantDiv = null;
          break;
        case 'error':
          if (currentAssistantDiv) {
            currentAssistantDiv.innerHTML = message.value;
            currentAssistantDiv.classList.add('error');
          }
          isWaiting = false;
          sendBtn.textContent = 'Send';
          currentAssistantDiv = null;
          scrollToBottom();
          break;
      }
    });

    // Cancel on Stop button when waiting
    sendBtn.addEventListener('click', (e) => {
      if (isWaiting && sendBtn.textContent === 'Stop') {
        e.preventDefault(); // stop sendPrompt from firing
        vscode.postMessage({ type: 'cancel' });
        isWaiting = false;
        sendBtn.textContent = 'Send';
        if (currentAssistantDiv) {
          currentAssistantDiv.innerHTML += '<br><br><em>(Cancelled)</em>';
          currentAssistantDiv = null;
        }
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
