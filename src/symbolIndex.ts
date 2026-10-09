/**
 * Phase 2 — lightweight symbol index for TS/JS (and similar).
 * Regex-based extraction plus optional VS Code DocumentSymbol enrichment
 * (uses installed language extensions — no CodePartner backend).
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export interface SymbolHit {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "export" | "import" | "method" | "property" | "other";
  relPath: string;
  line: number; // 1-based
  snippet: string;
}

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", ".next", "coverage",
  ".codepartner", "vendor",
]);

/** Extract symbol definitions from a single source file. */
export function extractSymbolsFromText(relPath: string, text: string): SymbolHit[] {
  const hits: SymbolHit[] = [];
  const lines = text.split(/\r?\n/);
  const patterns: Array<{ kind: SymbolHit["kind"]; re: RegExp }> = [
    { kind: "class", re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/ },
    { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_][\w]*)/ },
    { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_][\w]*)\s*=/ },
    { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_][\w]*)/ },
    { kind: "function", re: /^\s*(?:public|private|protected|static|async|\s)*([A-Za-z_][\w]*)\s*\([^;]*\)\s*\{/ },
    { kind: "const", re: /^\s*(?:export\s+)?const\s+([A-Za-z_][\w]*)\s*=\s*(?:async\s*)?\(/ },
    { kind: "const", re: /^\s*(?:export\s+)?const\s+([A-Za-z_][\w]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/ },
    { kind: "const", re: /^\s*(?:export\s+)?(?:let|var)\s+([A-Za-z_][\w]*)\s*=/ },
    { kind: "export", re: /^\s*export\s+\{\s*([^}]+)\s*\}/ },
    { kind: "export", re: /^\s*export\s+default\s+(?:function\s+)?([A-Za-z_][\w]*)/ },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { kind, re } of patterns) {
      const m = line.match(re);
      if (!m) {
        continue;
      }
      if (kind === "export") {
        const parts = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
        for (const name of parts) {
          if (/^[A-Za-z_][\w]*$/.test(name)) {
            hits.push({
              name,
              kind: "export",
              relPath,
              line: i + 1,
              snippet: line.trim().slice(0, 120),
            });
          }
        }
      } else {
        hits.push({
          name: m[1],
          kind,
          relPath,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
    }
    // imports — track local relative imports for dependency expansion
    const imp = line.match(/^\s*import\s+.*?from\s+['"](\.[^'"]+)['"]/);
    if (imp) {
      hits.push({
        name: imp[1],
        kind: "import",
        relPath,
        line: i + 1,
        snippet: line.trim().slice(0, 120),
      });
    }
  }
  return hits;
}

export class SymbolIndex {
  private byName = new Map<string, SymbolHit[]>();
  private byFile = new Map<string, SymbolHit[]>();
  private built = false;
  private output?: vscode.OutputChannel;

  constructor(output?: vscode.OutputChannel) {
    this.output = output;
  }

  isBuilt(): boolean {
    return this.built;
  }

  /**
   * Update index entries for one saved file (multi-root aware). Cheaper than full rebuild.
   */
  updateFile(absolutePath: string): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return;
    }
    const multi = folders.length > 1;
    const ext = path.extname(absolutePath).toLowerCase();
    if (!CODE_EXTS.has(ext)) {
      return;
    }
    const folder = folders.find((f) => {
      const root = f.uri.fsPath;
      const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
      const abs = path.resolve(absolutePath);
      return abs === root || abs.startsWith(rootSep);
    });
    if (!folder) {
      return;
    }
    const root = folder.uri.fsPath;
    let rel = path.relative(root, absolutePath).replace(/\\/g, "/");
    if (multi) {
      rel = `${folder.name}/${rel}`;
    }
    const prev = this.byFile.get(rel) || [];
    for (const h of prev) {
      if (h.kind === "import") {
        continue;
      }
      const key = h.name.toLowerCase();
      const list = (this.byName.get(key) || []).filter(
        (x) => !(x.relPath === rel && x.line === h.line && x.name === h.name)
      );
      if (list.length === 0) {
        this.byName.delete(key);
      } else {
        this.byName.set(key, list);
      }
    }
    this.byFile.delete(rel);
    let text: string;
    try {
      if (!fs.existsSync(absolutePath)) {
        return;
      }
      text = fs.readFileSync(absolutePath, "utf8");
    } catch {
      return;
    }
    if (text.length > 400_000) {
      return;
    }
    const hits = extractSymbolsFromText(rel, text);
    this.byFile.set(rel, hits);
    for (const h of hits) {
      if (h.kind === "import") {
        continue;
      }
      const key = h.name.toLowerCase();
      const list = this.byName.get(key) || [];
      list.push(h);
      this.byName.set(key, list);
    }
    this.built = true;
  }


  /**
   * Enrich index from VS Code document symbols (TypeScript/JS language service
   * when the corresponding extension is active). Merges with regex hits.
   */
  async enrichFromDocumentSymbols(uri: vscode.Uri): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return;
    }
    const multi = folders.length > 1;
    const abs = uri.fsPath;
    const folder = folders.find((f) => {
      const root = f.uri.fsPath;
      const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
      const resolved = path.resolve(abs);
      return resolved === root || resolved.startsWith(rootSep);
    });
    if (!folder) {
      return;
    }
    const root = folder.uri.fsPath;
    let rel = path.relative(root, abs).replace(/\\/g, "/");
    if (multi) {
      rel = `${folder.name}/${rel}`;
    }

    let symbols: vscode.DocumentSymbol[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri
      );
    } catch {
      return;
    }
    if (!symbols || symbols.length === 0) {
      return;
    }

    const mapKind = (k: vscode.SymbolKind): SymbolHit["kind"] => {
      switch (k) {
        case vscode.SymbolKind.Class:
        case vscode.SymbolKind.Struct:
          return "class";
        case vscode.SymbolKind.Interface:
          return "interface";
        case vscode.SymbolKind.Function:
        case vscode.SymbolKind.Constructor:
          return "function";
        case vscode.SymbolKind.Method:
          return "method";
        case vscode.SymbolKind.Property:
        case vscode.SymbolKind.Field:
          return "property";
        case vscode.SymbolKind.Variable:
        case vscode.SymbolKind.Constant:
          return "const";
        case vscode.SymbolKind.TypeParameter:
        case vscode.SymbolKind.Enum:
          return "type";
        default:
          return "other";
      }
    };

    const flat: SymbolHit[] = [];
    const walk = (syms: vscode.DocumentSymbol[]) => {
      for (const s of syms) {
        const name = (s.name || "").replace(/[($].*$/, "").trim();
        if (name && /^[A-Za-z_][\w]*$/.test(name)) {
          flat.push({
            name,
            kind: mapKind(s.kind),
            relPath: rel,
            line: s.range.start.line + 1,
            snippet: `${s.detail || s.name}`.slice(0, 120),
          });
        }
        if (s.children?.length) {
          walk(s.children);
        }
      }
    };
    walk(symbols);

    // Merge: keep existing regex hits for this file, add LSP ones not already present
    const existing = this.byFile.get(rel) || [];
    const seen = new Set(existing.map((h) => `${h.name.toLowerCase()}@${h.line}`));
    const merged = [...existing];
    for (const h of flat) {
      const id = `${h.name.toLowerCase()}@${h.line}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      merged.push(h);
      const key = h.name.toLowerCase();
      const list = this.byName.get(key) || [];
      list.push(h);
      this.byName.set(key, list);
    }
    this.byFile.set(rel, merged);
    this.built = true;
  }

  async build(maxFiles = 500): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return;
    }
    this.byName.clear();
    this.byFile.clear();
    let count = 0;
    const multi = folders.length > 1;

    const walk = (dir: string, root: string, folderLabel: string) => {
      if (count >= maxFiles) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (count >= maxFiles) {
          return;
        }
        if (ent.name.startsWith(".") && ent.name !== ".codepartner") {
          continue;
        }
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) {
            continue;
          }
          walk(full, root, folderLabel);
          continue;
        }
        const ext = path.extname(ent.name).toLowerCase();
        if (!CODE_EXTS.has(ext)) {
          continue;
        }
        let text: string;
        try {
          text = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (text.length > 400_000) {
          continue;
        }
        let rel = path.relative(root, full).replace(/\\/g, "/");
        // Multi-root: prefix with folder name so paths stay unambiguous
        if (multi) {
          rel = `${folderLabel}/${rel}`;
        }
        const hits = extractSymbolsFromText(rel, text);
        this.byFile.set(rel, hits);
        for (const h of hits) {
          if (h.kind === "import") {
            continue;
          }
          const key = h.name.toLowerCase();
          const list = this.byName.get(key) || [];
          list.push(h);
          this.byName.set(key, list);
        }
        count++;
      }
    };

    for (const folder of folders) {
      walk(folder.uri.fsPath, folder.uri.fsPath, folder.name);
    }
    this.built = true;
    this.output?.appendLine(
      `[CodePartner] Symbol index: ${count} files across ${folders.length} root(s), ${this.byName.size} symbols`
    );
  }

  /** Look up definition-like hits for identifier names found in the query. */
  lookupNames(names: string[], limit = 12): SymbolHit[] {
    const out: SymbolHit[] = [];
    const seen = new Set<string>();
    for (const raw of names) {
      const key = raw.toLowerCase();
      const list = this.byName.get(key) || [];
      for (const h of list) {
        const id = `${h.relPath}:${h.line}:${h.name}`;
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        out.push(h);
        if (out.length >= limit) {
          return out;
        }
      }
    }
    return out;
  }

  /**
   * Files that import a given relative module path (approximate).
   */
  findImporters(relPath: string, limit = 8): SymbolHit[] {
    const base = relPath.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
    const out: SymbolHit[] = [];
    for (const [, hits] of this.byFile) {
      for (const h of hits) {
        if (h.kind !== "import") {
          continue;
        }
        const target = h.name.replace(/^\.\//, "").replace(/\/index$/, "");
        if (
          base.endsWith(target.replace(/^\.\//, "")) ||
          target.includes(path.basename(base))
        ) {
          out.push(h);
          if (out.length >= limit) {
            return out;
          }
        }
      }
    }
    return out;
  }
}

/** Pull plausible identifiers from a user prompt. */
export function extractIdentifiersFromPrompt(prompt: string): string[] {
  const words = prompt.match(/\b[A-Z][a-zA-Z0-9]{2,}\b|\b[a-z][a-zA-Z0-9]{3,}\b/g) || [];
  const stop = new Set([
    "this", "that", "with", "from", "have", "been", "will", "would", "could",
    "should", "about", "which", "where", "when", "what", "make", "file", "code",
    "function", "class", "const", "please", "need", "want", "help", "using",
    "into", "they", "them", "your", "our", "the", "and", "for",
  ]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const k = w.toLowerCase();
    if (stop.has(k) || seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(w);
    if (out.length >= 20) {
      break;
    }
  }
  return out;
}
