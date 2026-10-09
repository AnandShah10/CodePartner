import * as vscode from "vscode";
import axios from "axios";
import { API_KEY_SECRET_KEY } from "./secretKeys";
import { buildProviderRequest, extractNonStreamedText } from "./aiProviderAdapter";
import { resolveModelId } from "./modelRouter";

/**
 * InlineCompletionProvider for CodePartner.
 * Provides ghost-text (Tab-to-accept) code completions using the configured LLM.
 */
export class CodePartnerInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRequestId = 0;
  private output: vscode.OutputChannel;
  private context: vscode.ExtensionContext;
  private cache = new Map<string, { result: string; timestamp: number }>();
  private readonly CACHE_TTL = 30_000; // 30 seconds

  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
    this.context = context;
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

    // Bug fix: this used to read config.get<string>("apiKey") directly,
    // which is the plaintext settings.json path CodePartner migrated
    // away from (see migrateApiKeyToSecretStorage in extension.ts) — so
    // since that migration shipped, the key here was always "", and
    // inline completions silently stopped working for every provider
    // except Ollama. Reads from SecretStorage now, same as everywhere else.
    const apiKey = (await this.context.secrets.get(API_KEY_SECRET_KEY)) || "";
    const provider = config.get<string>("provider") || "openai";
    if (!apiKey && provider !== "ollama") {
      return undefined;
    }

    // Debounce: wait for the configured delay
    const debounceMs = config.get<number>("inlineCompletionDebounce", 200);
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
      const completion = await this.getCompletion(document, position, token, apiKey);
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
    token: vscode.CancellationToken,
    apiKey: string
  ): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration("codepartner");
    const providerType = config.get<string>("provider") || "openai";
    const apiEndpoint = config.get<string>("apiEndpoint")?.trim() || "";
    // Phase 3 model router: optional dedicated completion model
    const modelId = resolveModelId("completion");
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
When the context implies more than the current line — e.g. the rest of a function body, a loop, an if/else block, or a multi-line object/array literal — complete the FULL block, not just the current line. Stop naturally at the end of that logical unit.

File: ${fileName} (${language})

${prefix}<CURSOR>${suffix}`;

    // Shared with the rest of the extension (aiProviderAdapter.ts) rather
    // than a second hand-rolled copy of the provider branching — this file
    // used to duplicate that logic, with its own drift risk (see the
    // module doc comment on aiProviderAdapter.ts for the bugs found the
    // last time two copies of this existed).
    const { url, headers, body } = buildProviderRequest({
      providerType, apiEndpoint, apiKey, modelId, azureApiVersion,
      messages: [{ role: "user", content: prompt }],
      useSystemRole: true,
      maxTokens: 384, // bumped from 256 so a legitimate multi-line block (a full function body, a loop) isn't cut off mid-way; still small enough to stay latency-reasonable for ghost text
      temperature: 0.2,
      stream: false,
    });
    // Stop sequences aren't part of the shared adapter's options (only
    // this call site needs them), so they're added on top of the built body.
    if (providerType === "anthropic") {
      body.stop_sequences = ["\n\n\n", "```"];
    } else if (providerType !== "google") {
      body.stop = ["\n\n\n", "```"];
    }

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());

    const res = await axios.post(url, body, {
      headers,
      timeout: 8000,
      signal: controller.signal,
    });

    let completion = extractNonStreamedText(providerType, res.data);

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
