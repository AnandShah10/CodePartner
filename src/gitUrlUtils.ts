/**
 * Parses a GitHub remote URL (SSH or HTTPS) into { owner, repo }.
 * Extracted from GitManager as a standalone pure function so it can be
 * unit tested directly — GitManager's constructor depends on the VS Code
 * extension host (`vscode.extensions.getExtension(...)`), so it can't be
 * instantiated outside one, even though this particular method never
 * touches any VS Code API.
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  // Non-greedy repo capture + an anchored optional ".git" suffix (rather
  // than "stop at the first dot") so a repo name that itself contains
  // dots — e.g. "some.repo.name" — isn't truncated.
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}