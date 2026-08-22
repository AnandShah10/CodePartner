import * as vscode from "vscode";
import axios from "axios";

/**
 * InlineCompletionProvider for CodePartner.
 * Provides ghost-text (Tab-to-accept) code completions using the configured LLM.
 */
export class CodePartnerInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRequestId = 0;
  private output: vscode.OutputChannel;
  private cache = new Map<string, { result: string; timestamp: number }>();
  private readonly CACHE_TTL = 30_000; // 30 seconds

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const config = vscode.workspace.getConfiguration("codepartner");
    const enabled = config.get<boolean>("inlineCompletions", false);
    if (!enabled) {
      return undefined;
    }

    const apiKey = config.get<string>("apiKey")?.trim() || "";
    const provider = config.get<string>("provider") || "openai";
    if (!apiKey && provider !== "ollama") {
      return undefined;
    }

    // Debounce: wait for the configured delay
    const debounceMs = config.get<number>("inlineCompletionDebounce", 500);
    const requestId = ++this.lastRequestId;

    await new Promise<void>((resolve) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(resolve, debounceMs);
    });

    // If a newer request was issued, cancel this one
    if (requestId !== this.lastRequestId || token.isCancellationRequested) {
      return undefined;
    }

    try {
      const completion = await this.getCompletion(document, position, token);
      if (!completion || token.isCancellationRequested) {
        return undefined;
      }

      return [
        new vscode.InlineCompletionItem(
          completion,
          new vscode.Range(position, position)
        ),
      ];
    } catch (e: any) {
      this.output.appendLine(`[CodePartner Inline] Error: ${e.message}`);
      return undefined;
    }
  }

  private async getCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration("codepartner");
    const providerType = config.get<string>("provider") || "openai";
    const apiEndpoint = config.get<string>("apiEndpoint")?.trim() || "";
    const apiKey = config.get<string>("apiKey")?.trim() || "";
    const modelId = config.get<string>("model")?.trim() || "";
    const azureApiVersion = config.get<string>("azureApiVersion") || "2024-02-15-preview";

    // Build context: lines before and after cursor
    const linesBefore = Math.max(0, position.line - 80);
    const linesAfter = Math.min(document.lineCount, position.line + 20);

    const prefix = document.getText(
      new vscode.Range(linesBefore, 0, position.line, position.character)
    );
    const suffix = document.getText(
      new vscode.Range(position.line, position.character, linesAfter, 0)
    );

    // Skip if line is empty or just whitespace
    const currentLine = document.lineAt(position.line).text;
    if (currentLine.trim().length === 0 && position.character === 0) {
      return undefined;
    }

    // Cache check
    const cacheKey = `${document.uri.toString()}:${position.line}:${prefix.slice(-100)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.result;
    }

    const language = document.languageId;
    const fileName = document.fileName.split(/[/\\]/).pop() || "file";

    const prompt = `You are a code completion engine. Complete the code at the cursor position marked with <CURSOR>.
Return ONLY the completion text. Do NOT include the existing code before the cursor. Do NOT include markdown formatting, code fences, or explanations.

File: ${fileName} (${language})

${prefix}<CURSOR>${suffix}`;

    const endpoint = apiEndpoint.replace(/\/$/, "");
    let url = "";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let body: any = {};

    if (providerType === "azure") {
      url = `${endpoint}/openai/deployments/${modelId}/chat/completions?api-version=${azureApiVersion}`;
      headers["api-key"] = apiKey;
      body = {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 256,
        temperature: 0.2,
        stop: ["\n\n\n", "```"],
      };
    } else if (providerType === "anthropic") {
      url = apiEndpoint || "https://api.anthropic.com/v1/messages";
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 256,
        temperature: 0.2,
        stop_sequences: ["\n\n\n", "```"],
      };
    } else if (providerType === "google") {
      url = `${apiEndpoint || "https://generativelanguage.googleapis.com/v1beta/openai"}/chat/completions`;
      headers["Authorization"] = `Bearer ${apiKey}`;
      body = {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 256,
        temperature: 0.2,
      };
    } else if (providerType === "ollama") {
      url = `${apiEndpoint || "http://localhost:11434/v1"}/chat/completions`;
      body = {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 256,
        temperature: 0.2,
        stop: ["\n\n\n", "```"],
      };
    } else {
      // OpenAI or compatible
      url = `${endpoint || "https://api.openai.com/v1"}/chat/completions`;
      headers["Authorization"] = `Bearer ${apiKey}`;
      body = {
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 256,
        temperature: 0.2,
        stop: ["\n\n\n", "```"],
      };
    }

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());

    const res = await axios.post(url, body, {
      headers,
      timeout: 8000,
      signal: controller.signal,
    });

    let completion = "";
    if (providerType === "anthropic") {
      completion = res.data?.content?.[0]?.text || "";
    } else {
      completion = res.data?.choices?.[0]?.message?.content || "";
    }

    // Clean up: remove code fences if the model wrapped the response
    completion = completion
      .replace(/^```[\w]*\n?/gm, "")
      .replace(/\n?```$/gm, "")
      .trim();

    if (completion) {
      this.cache.set(cacheKey, { result: completion, timestamp: Date.now() });

      // Prune old cache entries
      if (this.cache.size > 100) {
        const now = Date.now();
        for (const [key, val] of this.cache) {
          if (now - val.timestamp > this.CACHE_TTL) {
            this.cache.delete(key);
          }
        }
      }
    }

    return completion || undefined;
  }
}
