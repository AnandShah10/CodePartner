import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';

export class GitManager {
    private gitApi: any;

    constructor() {
        this.initialize();
    }

    private async initialize() {
        const extension = vscode.extensions.getExtension('vscode.git');
        if (extension) {
            const gitExtension = await extension.activate();
            this.gitApi = gitExtension.getAPI(1);
        }
    }

    private getRepository() {
        if (!this.gitApi || this.gitApi.repositories.length === 0) {
            return null;
        }
        return this.gitApi.repositories[0];
    }

    public async getDiff(): Promise<string> {
        const repo = this.getRepository();
        if (!repo) {
            return "No Git repository found.";
        }
        
        const diff = await repo.diff(true); // staged changes
        return diff || "No staged changes found.";
    }

    public async getStatus(): Promise<string> {
        const repo = this.getRepository();
        if (!repo) {
            return "No Git repository found.";
        }
        
        const status = await repo.status();
        return status.map((s: any) => `${s.status}: ${s.uri.fsPath}`).join('\n') || "Clean working directory.";
    }

    public async createBranch(name: string): Promise<string> {
        const repo = this.getRepository();
        if (!repo) {
            return "No Git repository found.";
        }
        
        try {
            await repo.createBranch(name, true);
            return `Successfully created and switched to branch: ${name}`;
        } catch (e: any) {
            return `Error creating branch: ${e.message}`;
        }
    }

    public async getStagedChanges(): Promise<string[]> {
        const repo = this.getRepository();
        if (!repo) {
            return [];
        }
        
        const changes = repo.state.indexChanges;
        return changes.map((c: any) => c.uri.fsPath);
    }

    public async stageAll(): Promise<string> {
        const repo = this.getRepository();
        if (!repo) {
            return "No Git repository found.";
        }
        try {
            await repo.add([]); 
            return "Successfully staged all changes.";
        } catch (e: any) {
            return `Error staging changes: ${e.message}`;
        }
    }

    public async commit(message: string): Promise<string> {
        const repo = this.getRepository();
        if (!repo) {
            return "No Git repository found.";
        }

        // AI co-author support
        const addCoAuthor = vscode.workspace.getConfiguration("codepartner").get<boolean>("addAICoAuthor", true);
        if (addCoAuthor) {
            const coAuthorTrailer = "\n\nCo-authored-by: CodePartner AI <codepartner@users.noreply.github.com>";
            if (!message.includes("Co-authored-by: CodePartner")) {
                message = message + coAuthorTrailer;
            }
        }

        try {
            await repo.commit(message);
            return `Successfully committed changes with message: ${message}`;
        } catch (e: any) {
            return `Error committing changes: ${e.message}`;
        }
    }

    /**
     * Push the current branch to its remote.
     */
    public async push(): Promise<string> {
        const repo = this.getRepository();
        if (!repo) {
            return "No Git repository found.";
        }
        try {
            await repo.push();
            return "Successfully pushed to remote.";
        } catch (e: any) {
            return `Error pushing to remote: ${e.message}`;
        }
    }

    /**
     * Get the current branch name.
     */
    public async getCurrentBranch(): Promise<string> {
        const repo = this.getRepository();
        if (!repo) {
            return "";
        }
        const head = repo.state.HEAD;
        return head?.name || "";
    }

    /**
     * Get the remote URL (for GitHub API).
     */
    public async getRemoteUrl(): Promise<string> {
        const repo = this.getRepository();
        if (!repo) {
            return "";
        }
        const remotes = repo.state.remotes;
        if (remotes.length === 0) {
            return "";
        }
        // Prefer 'origin'
        const origin = remotes.find((r: any) => r.name === "origin") || remotes[0];
        return origin?.pushUrl || origin?.fetchUrl || "";
    }

    /**
     * Parse a GitHub remote URL to extract owner and repo name.
     */
    public parseGitHubUrl(url: string): { owner: string; repo: string } | null {
        // Match SSH or HTTPS GitHub URLs
        const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
        if (match) {
            return { owner: match[1], repo: match[2] };
        }
        return null;
    }

    /**
     * Create a pull request on GitHub.
     */
    public async createPullRequest(title: string, body: string, baseBranch?: string): Promise<string> {
        try {
            // Get GitHub auth token from VS Code
            const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
            if (!session) {
                return "Error: GitHub authentication required. Please sign in to GitHub.";
            }

            const remoteUrl = await this.getRemoteUrl();
            if (!remoteUrl) {
                return "Error: No remote URL found.";
            }

            const parsed = this.parseGitHubUrl(remoteUrl);
            if (!parsed) {
                return `Error: Could not parse GitHub URL from remote: ${remoteUrl}`;
            }

            const currentBranch = await this.getCurrentBranch();
            if (!currentBranch) {
                return "Error: Could not determine current branch.";
            }

            // Push current branch first
            const pushResult = await this.push();
            if (pushResult.startsWith("Error")) {
                return pushResult;
            }

            // Create PR via GitHub API
            const axios = require("axios");
            const res = await axios.post(
                `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`,
                {
                    title,
                    body,
                    head: currentBranch,
                    base: baseBranch || "main",
                },
                {
                    headers: {
                        "Authorization": `Bearer ${session.accessToken}`,
                        "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                }
            );

            const prUrl = res.data.html_url;
            vscode.env.openExternal(vscode.Uri.parse(prUrl));
            return `Pull request created successfully: ${prUrl}`;
        } catch (e: any) {
            const msg = e.response?.data?.message || e.message;
            return `Error creating PR: ${msg}`;
        }
    }
}
