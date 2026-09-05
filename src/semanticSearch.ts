import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import axios from "axios";
import { buildEmbeddingRequest, extractEmbeddings, cosineSimilarity, chunkText, EmbeddingProviderType } from "./embeddings";

/**
 * TF-IDF based semantic workspace search, with an OPTIONAL real
 * embedding-based upgrade path.
 *
 * TF-IDF remains the default and the fallback for every failure mode —
 * no embedding provider configured, no API key, a network error, an
 * unexpected response shape. Embedding search is strictly opt-in via
 * configureEmbeddings(): unless a caller explicitly turns it on, nothing
 * about this class's behavior or cost changes from before.
 */

export interface EmbeddingConfig {
  providerType: EmbeddingProviderType;
  apiEndpoint: string;
  apiKey: string;
  model: string;
}

interface EmbeddingChunk {
  chunkIndex: number;
  text: string;
  vector: number[];
}

interface EmbeddingCacheEntry {
  contentHash: string;
  chunks: EmbeddingChunk[];
}

interface DocEntry {
  relPath: string;
  uri: vscode.Uri;
  terms: Map<string, number>; // term -> frequency
  totalTerms: number;
  content: string;
}

export class SemanticSearch {
  private index: DocEntry[] = [];
  private idf: Map<string, number> = new Map(); // term -> inverse document frequency
  private indexed = false;
  private output: vscode.OutputChannel;
  private watcher?: vscode.FileSystemWatcher;

  // Embedding search state — all inert unless configureEmbeddings() is called.
  private embeddingConfig: EmbeddingConfig | null = null;
  private embeddingCache: Map<string, EmbeddingCacheEntry> = new Map(); // relPath -> cached chunks/vectors
  private embeddingIndexBuilt = false;
  private embeddingDisabledForSession = false; // set true after a hard failure (e.g. bad key) so we don't retry every file

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  /**
   * Opts into real embedding-based search. Pass null to go back to
   * TF-IDF only. Changing this invalidates the embedding index so it
   * rebuilds (with a fresh provider/model) on the next search.
   */
  public configureEmbeddings(config: EmbeddingConfig | null): void {
    this.embeddingConfig = config;
    this.embeddingIndexBuilt = false;
    this.embeddingDisabledForSession = false;
  }

  /**
   * Build the TF-IDF index from workspace files.
   */
  public async buildIndex(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return;
    }

    this.output.appendLine("[SemanticSearch] Building workspace index...");
    const startTime = Date.now();

    const files = await vscode.workspace.findFiles(
      "**/*",
      "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.venv/**,**/__pycache__/**,**/*.vsix}",
      500
    );

    this.index = [];
    const docFreq: Map<string, number> = new Map(); // term -> num documents containing it

    for (const file of files) {
      try {
        const stat = await vscode.workspace.fs.stat(file);
        // Skip files > 500KB
        if (stat.size > 500_000) {
          continue;
        }

        const doc = await vscode.workspace.openTextDocument(file);
        // Skip binary-ish files
        if (doc.languageId === "binary" || doc.languageId === "image") {
          continue;
        }

        const content = doc.getText();
        const relPath = vscode.workspace.asRelativePath(file);
        const terms = this.tokenize(content);

        const entry: DocEntry = {
          relPath,
          uri: file,
          terms,
          totalTerms: Array.from(terms.values()).reduce((a, b) => a + b, 0),
          content,
        };

        this.index.push(entry);

        // Update document frequency
        for (const term of terms.keys()) {
          docFreq.set(term, (docFreq.get(term) || 0) + 1);
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Calculate IDF
    const N = this.index.length;
    this.idf.clear();
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
    }

    this.indexed = true;
    this.output.appendLine(
      `[SemanticSearch] Indexed ${this.index.length} files in ${Date.now() - startTime}ms`
    );

    // Set up file watcher for incremental updates
    if (!this.watcher) {
      this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
      this.watcher.onDidChange(() => this.invalidate());
      this.watcher.onDidCreate(() => this.invalidate());
      this.watcher.onDidDelete(() => this.invalidate());
    }
  }

  private invalidate(): void {
    this.indexed = false;
    // Don't clear embeddingCache itself — it's keyed by content hash, so
    // an unchanged file's vectors are still valid and reused for free.
    // Just allow buildEmbeddingIndex() to run again so changed/new files
    // get re-embedded.
    this.embeddingIndexBuilt = false;
  }

  /**
   * Searches the workspace. Uses real embedding-based search when
   * configureEmbeddings() has been called and the embedding index built
   * successfully; falls back to TF-IDF on any failure — no configured
   * provider, an API error, a bad response, or the index simply not
   * being ready yet on the very first call.
   */
  public async search(
    query: string,
    topN: number = 8
  ): Promise<{ path: string; score: number; excerpt: string }[]> {
    if (!this.indexed) {
      await this.buildIndex();
    }

    if (this.embeddingConfig && !this.embeddingDisabledForSession) {
      try {
        if (!this.embeddingIndexBuilt) {
          await this.buildEmbeddingIndex();
        }
        if (this.embeddingIndexBuilt) {
          const results = await this.searchByEmbedding(query, topN);
          if (results.length > 0) {
            return results;
          }
        }
      } catch (e: any) {
        this.output.appendLine(`[SemanticSearch] Embedding search failed, falling back to TF-IDF: ${e.message}`);
      }
    }

    return this.searchTfIdf(query, topN);
  }

  /**
   * Builds the embedding index: chunks each already-TF-IDF-indexed
   * file's content and embeds each chunk, skipping files whose content
   * hash hasn't changed since the last successful embed (content-hash
   * cache — avoids re-paying for an API call on every rebuild for files
   * that haven't changed). If the very first embedding call fails
   * outright (bad key, network down, wrong model name), embedding search
   * is disabled for the rest of this session rather than retried on
   * every subsequent file — TF-IDF keeps working regardless.
   */
  private async buildEmbeddingIndex(): Promise<void> {
    if (!this.embeddingConfig) return;
    const config = this.embeddingConfig;
    let firstCallAttempted = false;

    for (const doc of this.index) {
      const contentHash = crypto.createHash("sha256").update(doc.content).digest("hex");
      const cached = this.embeddingCache.get(doc.relPath);
      if (cached && cached.contentHash === contentHash) {
        continue; // unchanged since last embed — reuse cached vectors, no API call
      }

      const pieces = chunkText(doc.content, 2000, 200);
      if (pieces.length === 0) continue;

      try {
        const vectors = await this.embedTexts(config, pieces);
        firstCallAttempted = true;
        if (vectors.length !== pieces.length) {
          this.output.appendLine(`[SemanticSearch] Embedding count mismatch for ${doc.relPath} (got ${vectors.length}, expected ${pieces.length}) — skipping this file.`);
          continue;
        }
        const chunks: EmbeddingChunk[] = pieces.map((text, i) => ({ chunkIndex: i, text, vector: vectors[i] }));
        this.embeddingCache.set(doc.relPath, { contentHash, chunks });
      } catch (e: any) {
        if (!firstCallAttempted) {
          // The very first call failed outright — likely a config problem
          // (bad key, wrong URL, unreachable). Don't hammer it once per file.
          this.embeddingDisabledForSession = true;
          this.output.appendLine(`[SemanticSearch] Embedding provider unreachable, disabling embedding search for this session (TF-IDF still works): ${e.message}`);
          return;
        }
        this.output.appendLine(`[SemanticSearch] Failed to embed ${doc.relPath}, skipping it: ${e.message}`);
      }
    }

    this.embeddingIndexBuilt = this.embeddingCache.size > 0;

    // Prune cache entries for files that no longer exist / were removed
    // from the workspace — otherwise a deleted file's vectors would keep
    // surfacing in search results indefinitely.
    const currentPaths = new Set(this.index.map((d) => d.relPath));
    for (const cachedPath of this.embeddingCache.keys()) {
      if (!currentPaths.has(cachedPath)) {
        this.embeddingCache.delete(cachedPath);
      }
    }
  }

  /** Calls the configured embedding provider for one or more text chunks, batching when the provider supports it (only Ollama's endpoint doesn't). */
  private async embedTexts(config: EmbeddingConfig, texts: string[]): Promise<number[][]> {
    if (config.providerType !== "ollama") {
      const { url, headers, body } = buildEmbeddingRequest({
        providerType: config.providerType, apiEndpoint: config.apiEndpoint,
        apiKey: config.apiKey, model: config.model, input: texts,
      });
      const res = await axios.post(url, body, { headers, timeout: 20000 });
      return extractEmbeddings(config.providerType, res.data);
    }

    // Ollama's endpoint takes one prompt per call, not a batch array.
    const vectors: number[][] = [];
    for (const text of texts) {
      const { url, headers, body } = buildEmbeddingRequest({
        providerType: config.providerType, apiEndpoint: config.apiEndpoint,
        apiKey: config.apiKey, model: config.model, input: text,
      });
      const res = await axios.post(url, body, { headers, timeout: 20000 });
      const extracted = extractEmbeddings(config.providerType, res.data);
      if (extracted.length > 0) vectors.push(extracted[0]);
    }
    return vectors;
  }

  /** Embedding-based search: cosine similarity between the query vector and every cached chunk, best chunk per file wins. */
  private async searchByEmbedding(
    query: string,
    topN: number
  ): Promise<{ path: string; score: number; excerpt: string }[]> {
    if (!this.embeddingConfig) return [];
    const queryVectors = await this.embedTexts(this.embeddingConfig, [query]);
    if (queryVectors.length === 0) return [];
    const queryVector = queryVectors[0];

    const bestPerFile = new Map<string, { score: number; excerpt: string }>();
    for (const [relPath, entry] of this.embeddingCache) {
      for (const chunk of entry.chunks) {
        const score = cosineSimilarity(queryVector, chunk.vector);
        const existing = bestPerFile.get(relPath);
        if (!existing || score > existing.score) {
          bestPerFile.set(relPath, { score, excerpt: chunk.text });
        }
      }
    }

    return Array.from(bestPerFile.entries())
      .map(([path, v]) => ({ path, score: v.score, excerpt: v.excerpt }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
  }

  /**
   * Search the workspace using TF-IDF scoring.
   * Returns the top N most relevant files with matching excerpts.
   */
  private async searchTfIdf(
    query: string,
    topN: number = 8
  ): Promise<{ path: string; score: number; excerpt: string }[]> {
    const queryTerms = this.tokenize(query);
    const results: { path: string; score: number; excerpt: string }[] = [];

    for (const doc of this.index) {
      let score = 0;

      for (const [term, queryFreq] of queryTerms) {
        const docTf = (doc.terms.get(term) || 0) / (doc.totalTerms || 1);
        const idfVal = this.idf.get(term) || 0;
        score += docTf * idfVal * queryFreq;
      }

      // Boost score for filename matches
      const baseName = doc.relPath.split(/[/\\]/).pop()?.toLowerCase() || "";
      for (const term of queryTerms.keys()) {
        if (baseName.includes(term)) {
          score *= 2.5;
        }
      }

      if (score > 0) {
        // Find best matching excerpt
        const excerpt = this.findBestExcerpt(doc.content, queryTerms);
        results.push({ path: doc.relPath, score, excerpt });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topN);
  }

  /**
   * Find the most relevant excerpt from a document.
   */
  private findBestExcerpt(
    content: string,
    queryTerms: Map<string, number>
  ): string {
    const lines = content.split("\n");
    let bestStart = 0;
    let bestScore = 0;
    const windowSize = 10;

    for (let i = 0; i < lines.length; i++) {
      const windowEnd = Math.min(i + windowSize, lines.length);
      const windowText = lines.slice(i, windowEnd).join("\n").toLowerCase();
      let windowScore = 0;

      for (const term of queryTerms.keys()) {
        const count = (windowText.match(new RegExp(this.escapeRegex(term), "g")) || []).length;
        windowScore += count * (this.idf.get(term) || 1);
      }

      if (windowScore > bestScore) {
        bestScore = windowScore;
        bestStart = i;
      }
    }

    return lines
      .slice(bestStart, Math.min(bestStart + windowSize, lines.length))
      .map((l) => l.trimEnd())
      .join("\n");
  }

  /**
   * Tokenize text into term frequencies.
   */
  private tokenize(text: string): Map<string, number> {
    const terms = new Map<string, number>();
    // Split on word boundaries, convert to lowercase
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && w.length < 50);

    // Also split camelCase and snake_case
    const expanded: string[] = [];
    for (const word of words) {
      expanded.push(word);
      // camelCase split
      const camelParts = word.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(" ");
      if (camelParts.length > 1) {
        expanded.push(...camelParts.filter((p) => p.length > 2));
      }
      // snake_case split
      const snakeParts = word.split("_").filter((p) => p.length > 2);
      if (snakeParts.length > 1) {
        expanded.push(...snakeParts);
      }
    }

    // Stop words
    const stopWords = new Set([
      "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
      "her", "was", "one", "our", "out", "has", "have", "from", "this", "that",
      "with", "they", "been", "said", "each", "which", "their", "will", "other",
      "about", "many", "then", "them", "these", "some", "would", "make", "like",
      "into", "could", "time", "very", "when", "come", "made", "find", "more",
      "long", "look", "use", "its", "than", "first", "also", "new", "way",
      "may", "any", "let", "var", "const", "function", "return", "import", "export",
      "class", "interface", "type", "void", "string", "number", "boolean", "null",
      "undefined", "true", "false", "else", "case", "break", "default",
    ]);

    for (const word of expanded) {
      if (!stopWords.has(word)) {
        terms.set(word, (terms.get(word) || 0) + 1);
      }
    }

    return terms;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  public dispose(): void {
    this.watcher?.dispose();
  }
}