import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

/**
 * TF-IDF based semantic workspace search.
 * Much better than naive keyword matching for @workspace queries.
 */

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

  constructor(output: vscode.OutputChannel) {
    this.output = output;
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
  }

  /**
   * Search the workspace using TF-IDF scoring.
   * Returns the top N most relevant files with matching excerpts.
   */
  public async search(
    query: string,
    topN: number = 8
  ): Promise<{ path: string; score: number; excerpt: string }[]> {
    if (!this.indexed) {
      await this.buildIndex();
    }

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
