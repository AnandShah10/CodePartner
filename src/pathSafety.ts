/**
 * Workspace path containment — Phase 0 security (roadmap).
 * Every file tool should resolve through `resolveWorkspacePath` and refuse
 * paths that escape the workspace / worktree root.
 */

import * as path from "path";

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
  }
}

/**
 * Resolves `relPath` under `root` and ensures the result stays inside root.
 * Rejects absolute paths that point outside, `..` escapes, etc.
 */
export function resolveWorkspacePath(root: string, relPath: string): string {
  if (!root) {
    throw new PathEscapeError("No workspace root.");
  }
  const normalizedRoot = path.resolve(root);
  // Treat absolute input as relative-to-root only if it is already under root
  const candidate = path.isAbsolute(relPath)
    ? path.resolve(relPath)
    : path.resolve(normalizedRoot, relPath);

  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;

  if (candidate !== normalizedRoot && !candidate.startsWith(rootWithSep)) {
    throw new PathEscapeError(
      `Path escapes workspace root: "${relPath}" → "${candidate}" (root: ${normalizedRoot})`
    );
  }
  return candidate;
}

/** Soft check — returns error string or null if safe. */
export function checkWorkspacePath(root: string, relPath: string): string | null {
  try {
    resolveWorkspacePath(root, relPath);
    return null;
  } catch (e: any) {
    return e?.message || String(e);
  }
}
