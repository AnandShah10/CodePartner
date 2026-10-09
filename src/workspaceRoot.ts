/**
 * Phase 2 / multi-root — pick the workspace folder a tool or context
 * operation should use, instead of always folder[0].
 */

import * as vscode from "vscode";
import * as path from "path";

/**
 * Prefer:
 * 1. Workspace folder owning the active editor
 * 2. Folder owning the given absolute/relative hint path
 * 3. First workspace folder
 */
export function getPreferredWorkspaceRoot(hintPath?: string): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }

  const active = vscode.window.activeTextEditor?.document?.uri;
  if (active && (active.scheme === "file" || active.scheme === "vscode-remote")) {
    const f = vscode.workspace.getWorkspaceFolder(active);
    if (f) {
      return f.uri.fsPath;
    }
  }

  if (hintPath) {
    const abs = path.isAbsolute(hintPath)
      ? path.resolve(hintPath)
      : null;
    if (abs) {
      for (const folder of folders) {
        const root = folder.uri.fsPath;
        const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
        if (abs === root || abs.startsWith(rootSep)) {
          return root;
        }
      }
    }
    // Relative path: if only one folder contains a matching file, use it
    for (const folder of folders) {
      try {
        const candidate = path.join(folder.uri.fsPath, hintPath);
        const fs = require("fs") as typeof import("fs");
        if (fs.existsSync(candidate)) {
          return folder.uri.fsPath;
        }
      } catch {
        /* ignore */
      }
    }
  }

  return folders[0].uri.fsPath;
}

/** Human-readable list of roots for system/context prompts. */
export function formatWorkspaceRoots(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return "(no workspace open)";
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  return folders
    .map((f, i) => `${i + 1}. ${f.name}: ${f.uri.fsPath}`)
    .join("\n");
}
