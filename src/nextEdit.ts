import * as vscode from "vscode";

/**
 * Finish Changes + Next Edit Suggestions for CodePartner.
 *
 * Finish Changes: after a partial edit (e.g. rename one occurrence, or change
 * one structural pattern), detect remaining similar sites in the same file and
 * offer to complete them.
 *
 * Next Edit Suggestions (NES): after the user edits, surface the next location
 * with a decoration + CodeLens; commands apply one or all remaining edits.
 */

export interface PendingEdit {
  uri: vscode.Uri;
  range: vscode.Range;
  newText: string;
  reason: string;
  oldText: string;
}

export class NextEditManager implements vscode.Disposable {
  private output: vscode.OutputChannel;
  private disposables: vscode.Disposable[] = [];
  private pending: PendingEdit[] = [];
  private decorationType: vscode.TextEditorDecorationType;
  private statusBar: vscode.StatusBarItem;
  private analyzeTimer: ReturnType<typeof setTimeout> | undefined;
  private codeLensProvider: FinishChangesCodeLensProvider;
  private enabled = true;

  /** Full document text from before the latest change (per URI). */
  private snapshots = new Map<string, string>();

  constructor(output: vscode.OutputChannel) {
    this.output = output;

    this.decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
      border: "1px solid",
      borderColor: new vscode.ThemeColor("editorInfo.foreground"),
      overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: {
        contentText: "  ← next edit",
        color: new vscode.ThemeColor("editorInfo.foreground"),
        fontStyle: "italic",
        margin: "0 0 0 8px",
      },
    });

    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBar.command = "codepartner.applyNextEdit";
    this.statusBar.tooltip =
      "CodePartner: Apply next suggested edit (Finish Changes / NES)";

    this.codeLensProvider = new FinishChangesCodeLensProvider(() => this.pending);

    this.disposables.push(
      this.decorationType,
      this.statusBar,
      vscode.languages.registerCodeLensProvider(
        { scheme: "file" },
        this.codeLensProvider
      ),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e)),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed) {
          this.ensureSnapshot(ed.document);
        }
        this.refreshDecorations();
      }),
      vscode.workspace.onDidOpenTextDocument((doc) => this.ensureSnapshot(doc)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("codepartner.nextEditSuggestions")) {
          this.enabled = vscode.workspace
            .getConfiguration("codepartner")
            .get<boolean>("nextEditSuggestions", true);
          if (!this.enabled) {
            this.clearPending();
          }
        }
      })
    );

    this.enabled = vscode.workspace
      .getConfiguration("codepartner")
      .get<boolean>("nextEditSuggestions", true);

    // Seed snapshots for open editors
    for (const ed of vscode.window.visibleTextEditors) {
      this.ensureSnapshot(ed.document);
    }
  }

  dispose() {
    if (this.analyzeTimer) {
      clearTimeout(this.analyzeTimer);
    }
    this.disposables.forEach((d) => d.dispose());
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  async applyNextEdit(): Promise<void> {
    if (this.pending.length === 0) {
      vscode.window.showInformationMessage("CodePartner: No pending next edits.");
      return;
    }
    const edit = this.pending[0];
    await this.applyEdit(edit);
    this.pending.shift();
    this.refreshUI();
    this.codeLensProvider.refresh();
  }

  async applyAllPending(): Promise<void> {
    if (this.pending.length === 0) {
      vscode.window.showInformationMessage("CodePartner: No pending edits to finish.");
      return;
    }
    const count = this.pending.length;
    // Reverse order so earlier ranges stay valid
    const sorted = [...this.pending].sort((a, b) => {
      if (a.uri.toString() !== b.uri.toString()) {
        return a.uri.toString().localeCompare(b.uri.toString());
      }
      return (
        b.range.start.line - a.range.start.line ||
        b.range.start.character - a.range.start.character
      );
    });
    for (const edit of sorted) {
      await this.applyEdit(edit);
    }
    this.pending = [];
    this.refreshUI();
    this.codeLensProvider.refresh();
    vscode.window.showInformationMessage(
      `CodePartner: Finished ${count} change${count === 1 ? "" : "s"}.`
    );
  }

  dismissPending(): void {
    this.clearPending();
    vscode.window.setStatusBarMessage(
      "CodePartner: Next-edit suggestions dismissed",
      2000
    );
  }

  // ── Change pipeline ──────────────────────────────────────────────────────

  private onDocumentChange(e: vscode.TextDocumentChangeEvent) {
    if (!this.enabled) {
      return;
    }
    if (e.document.uri.scheme !== "file") {
      return;
    }
    if (e.contentChanges.length === 0) {
      return;
    }

    const totalChars = e.contentChanges.reduce(
      (n, c) => n + c.text.length + (c.rangeLength || 0),
      0
    );
    // Skip bulk paste / format
    if (totalChars > 2000) {
      this.ensureSnapshot(e.document);
      return;
    }

    // Capture pre-change text before overwriting the snapshot
    const key = e.document.uri.toString();
    const preText = this.snapshots.get(key) ?? null;

    if (this.analyzeTimer) {
      clearTimeout(this.analyzeTimer);
    }
    this.analyzeTimer = setTimeout(() => {
      void this.analyze(e.document, e.contentChanges, preText);
      // Post-change snapshot for the next event
      this.ensureSnapshot(e.document);
    }, 400);
  }

  private ensureSnapshot(document: vscode.TextDocument) {
    if (document.uri.scheme !== "file") {
      return;
    }
    this.snapshots.set(document.uri.toString(), document.getText());
  }

  private async analyze(
    document: vscode.TextDocument,
    changes: readonly vscode.TextDocumentContentChangeEvent[],
    preText: string | null
  ) {
    if (!this.enabled) {
      return;
    }

    const suggestions: PendingEdit[] = [];

    for (const change of changes) {
      if (preText) {
        const rename = this.detectLocalRename(document, change, preText);
        if (rename.length) {
          suggestions.push(...rename);
          continue;
        }
        const structural = this.detectStructuralRepeat(document, change, preText);
        if (structural.length) {
          suggestions.push(...structural);
        }
      }
    }

    if (suggestions.length === 0) {
      return;
    }

    const editKey = (e: PendingEdit) =>
      `${e.uri.toString()}:${e.range.start.line}:${e.range.start.character}:${e.range.end.line}:${e.range.end.character}:${e.newText}`;
    const seen = new Set(this.pending.map(editKey));
    for (const s of suggestions) {
      if (!seen.has(editKey(s))) {
        this.pending.push(s);
        seen.add(editKey(s));
      }
    }
    if (this.pending.length > 30) {
      this.pending = this.pending.slice(0, 30);
    }

    this.output.appendLine(
      `[CodePartner NES] +${suggestions.length} suggestion(s); ${this.pending.length} pending`
    );
    this.refreshUI();
    this.codeLensProvider.refresh();
  }

  /**
   * User replaced identifier oldWord → newWord in one place; suggest the same
   * replacement for remaining word-boundary occurrences in this file and other
   * open editors (multi-file NES).
   */
  private detectLocalRename(
    document: vscode.TextDocument,
    change: vscode.TextDocumentContentChangeEvent,
    preText: string
  ): PendingEdit[] {
    const newWord = change.text.trim();
    if (!newWord || newWord.length > 64 || !/^[\w$]+$/.test(newWord)) {
      return [];
    }

    const startOffset = change.rangeOffset;
    const oldWord = preText
      .slice(startOffset, startOffset + (change.rangeLength || 0))
      .trim();
    if (!oldWord || !/^[\w$]+$/.test(oldWord) || oldWord === newWord) {
      return [];
    }
    if (oldWord.length < 2) {
      return [];
    }

    const results: PendingEdit[] = [];
    const docs = this.documentsToScan(document);
    for (const doc of docs) {
      results.push(...this.findRenameSites(doc, oldWord, newWord));
    }
    // Full-repo pattern NES (async; does not block the editor)
    void this.scanWorkspaceForRename(oldWord, newWord, document.uri);
    return results.slice(0, 40);
  }

  /**
   * Workspace-wide rename sites outside already-open editors.
   * Uses findFiles + openTextDocument (stable @types/vscode) instead of
   * findTextInFiles, which is not in all published type packages.
   */
  private async scanWorkspaceForRename(
    oldWord: string,
    newWord: string,
    excludeUri: vscode.Uri
  ): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return;
    }
    try {
      const hits: PendingEdit[] = [];
      const uris = await vscode.workspace.findFiles(
        "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,swift,c,cc,cpp,h,hpp,cs,rb,php}",
        "**/{node_modules,.git,dist,out,build,.next,coverage}/**",
        80
      );

      for (const uri of uris) {
        if (uri.toString() === excludeUri.toString()) {
          continue;
        }
        let doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === uri.toString()
        );
        if (!doc) {
          try {
            doc = await vscode.workspace.openTextDocument(uri);
          } catch {
            continue;
          }
        }
        // Cheap prefilter: skip files that don't contain the old identifier
        if (!new RegExp(`\\b${escapeRegExp(oldWord)}\\b`).test(doc.getText())) {
          continue;
        }
        hits.push(...this.findRenameSites(doc, oldWord, newWord));
        if (hits.length >= 40) {
          break;
        }
      }

      if (hits.length === 0) {
        return;
      }
      const editKey = (e: PendingEdit) =>
        `${e.uri.toString()}:${e.range.start.line}:${e.range.start.character}:${e.newText}`;
      const seen = new Set(this.pending.map(editKey));
      let added = 0;
      for (const h of hits) {
        if (seen.has(editKey(h))) {
          continue;
        }
        this.pending.push(h);
        seen.add(editKey(h));
        added++;
        if (this.pending.length > 50) {
          break;
        }
      }
      if (added > 0) {
        this.output.appendLine(`[CodePartner NES] +${added} workspace rename site(s)`);
        this.refreshUI();
        this.codeLensProvider.refresh();
      }
    } catch (e: any) {
      this.output.appendLine(`[CodePartner NES] workspace scan failed: ${e.message}`);
    }
  }

  /** Open editors + the active document (deduped). Caps workspace walk cost. */
  private documentsToScan(primary: vscode.TextDocument): vscode.TextDocument[] {
    const byUri = new Map<string, vscode.TextDocument>();
    byUri.set(primary.uri.toString(), primary);
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme === "file") {
        byUri.set(ed.document.uri.toString(), ed.document);
      }
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === "file" && !doc.isClosed) {
        byUri.set(doc.uri.toString(), doc);
      }
    }
    return Array.from(byUri.values());
  }

  private findRenameSites(
    document: vscode.TextDocument,
    oldWord: string,
    newWord: string
  ): PendingEdit[] {
    const text = document.getText();
    const results: PendingEdit[] = [];
    const re = new RegExp(`\\b${escapeRegExp(oldWord)}\\b`, "g");
    const rel = vscode.workspace.asRelativePath(document.uri);
    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    const isActive = document.uri.toString() === activeUri;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = document.positionAt(m.index);
      const end = document.positionAt(m.index + oldWord.length);
      const range = new vscode.Range(start, end);
      if (document.getText(range) !== oldWord) {
        continue;
      }
      results.push({
        uri: document.uri,
        range,
        newText: newWord,
        oldText: oldWord,
        reason: isActive
          ? `Rename remaining "${oldWord}" → "${newWord}"`
          : `Rename in ${rel}: "${oldWord}" → "${newWord}"`,
      });
    }
    return results;
  }

  /**
   * User changed a full line that had identical copies elsewhere (this file
   * and other open editors); suggest applying the same line body.
   */
  private detectStructuralRepeat(
    document: vscode.TextDocument,
    change: vscode.TextDocumentContentChangeEvent,
    preText: string
  ): PendingEdit[] {
    if (change.text.includes("\n")) {
      return [];
    }

    const preLines = preText.split(/\r?\n/);
    const lineIdx = change.range.start.line;
    if (lineIdx < 0 || lineIdx >= preLines.length) {
      return [];
    }

    const oldLine = preLines[lineIdx];
    const newLine = document.lineAt(
      Math.min(lineIdx, document.lineCount - 1)
    ).text;

    if (oldLine === newLine) {
      return [];
    }
    if (oldLine.trim().length < 4) {
      return [];
    }
    if (change.rangeLength === 0 && change.text.length <= 2) {
      return [];
    }

    const results: PendingEdit[] = [];
    const docs = this.documentsToScan(document);
    for (const doc of docs) {
      const lines = doc.getText().split(/\r?\n/);
      const rel = vscode.workspace.asRelativePath(doc.uri);
      for (let i = 0; i < lines.length; i++) {
        if (doc.uri.toString() === document.uri.toString() && i === lineIdx) {
          continue;
        }
        const candidate = lines[i];
        if (candidate !== oldLine) {
          continue;
        }
        const indent = candidate.match(/^\s*/)?.[0] ?? "";
        const newBody = newLine.replace(/^\s*/, "");
        const replacement = indent + newBody;
        if (replacement === candidate) {
          continue;
        }
        results.push({
          uri: doc.uri,
          range: new vscode.Range(i, 0, i, candidate.length),
          newText: replacement,
          oldText: candidate,
          reason:
            doc.uri.toString() === document.uri.toString()
              ? "Finish similar line change"
              : `Finish similar line in ${rel}`,
        });
      }
    }
    return results.slice(0, 25);
  }

  private async applyEdit(edit: PendingEdit): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(edit.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    // Re-validate range content
    if (edit.range.end.line >= doc.lineCount) {
      return;
    }
    const current = doc.getText(edit.range);
    if (current === edit.newText) {
      return; // already applied
    }
    if (edit.oldText && current !== edit.oldText) {
      // File drifted — skip this one
      this.output.appendLine(
        `[CodePartner NES] Skipped drifted edit at ${edit.range.start.line + 1}: expected "${edit.oldText}", found "${current}"`
      );
      return;
    }

    const success = await editor.edit((b) => {
      b.replace(edit.range, edit.newText);
    });
    if (success) {
      const endPos = edit.range.start.translate(
        0,
        edit.newText.includes("\n")
          ? edit.newText.split("\n").pop()!.length
          : edit.newText.length
      );
      editor.selection = new vscode.Selection(edit.range.start, endPos);
      editor.revealRange(
        new vscode.Range(edit.range.start, endPos),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );
      this.ensureSnapshot(doc);
    }
  }

  private clearPending() {
    this.pending = [];
    this.refreshUI();
    this.codeLensProvider.refresh();
  }

  private refreshUI() {
    this.refreshDecorations();
    if (this.pending.length === 0) {
      this.statusBar.hide();
    } else {
      this.statusBar.text = `$(edit) ${this.pending.length} next edit${
        this.pending.length === 1 ? "" : "s"
      }`;
      this.statusBar.show();
    }
  }

  private refreshDecorations() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const ranges = this.pending
      .filter((p) => p.uri.toString() === editor.document.uri.toString())
      .map((p) => p.range);
    editor.setDecorations(this.decorationType, ranges);
  }
}

class FinishChangesCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  private getPending: () => PendingEdit[];

  constructor(getPending: () => PendingEdit[]) {
    this.getPending = getPending;
  }

  refresh() {
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const pending = this.getPending().filter(
      (p) => p.uri.toString() === document.uri.toString()
    );
    if (pending.length === 0) {
      return [];
    }

    const first = pending[0];
    return [
      new vscode.CodeLens(first.range, {
        title: `$(check) Finish ${pending.length} change${
          pending.length === 1 ? "" : "s"
        }`,
        command: "codepartner.finishChanges",
      }),
      new vscode.CodeLens(first.range, {
        title: "Apply next",
        command: "codepartner.applyNextEdit",
      }),
      new vscode.CodeLens(first.range, {
        title: "Dismiss",
        command: "codepartner.dismissNextEdits",
      }),
    ];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
