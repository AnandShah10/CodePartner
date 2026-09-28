# CodePartner vs. Competitors (Antigravity, Claude Code, GitHub Copilot)

**Updated against the current codebase** (following a security/reliability/feature pass — see changelog note at the end). Competitor columns are **unchanged from the original document** — this update only re-verified CodePartner's own claims against its source, and corrects several that were wrong. Where I couldn't verify a competitor claim, I left it as-is rather than guess.

---

## 1. Architecture Overview

| Aspect | CodePartner | Antigravity (Google) | Claude Code (Anthropic) | GitHub Copilot |
|:---|:---|:---|:---|:---|
| **Form Factor** | VS Code sidebar extension | Standalone IDE (VS Code fork) | CLI tool + VS Code + Desktop + Browser | Built-in to VS Code |
| **Runtime** | Single extension process | Full IDE with Agent Manager | Multi-surface (terminal, IDE, cloud) | VS Code native + cloud agents |
| **Codebase** | ~6,200 LOC TypeScript + ~1,500 LOC JS + ~1,300 LOC tests, 24 TS modules | Full IDE application | Enterprise-grade Rust/Python | Microsoft-backed platform |
| **API Approach** | BYO API key (multi-provider), stored in OS keychain via SecretStorage | Google models + 3rd party | Anthropic API (subscription) | GitHub subscription |
| **Offline Support** | ✅ Via Ollama | ❌ Cloud-only | ❌ Cloud-only | ❌ Cloud-only |

> [!NOTE]
> Codebase size roughly doubled since the last version of this doc — mostly reliability/security fixes and new modules, not UI surface. `media/main.js` (the webview) is nearly unchanged in size.

> [!TIP]
> CodePartner's BYO-key + Ollama model is still a **unique strength** — none of the competitors offer true local/offline AI without a subscription.

---

## 2. Core Feature Comparison

### 2.1 Inline Code Completion (Ghost Text)

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Tab-complete ghost text | ✅ | ✅ | ❌ (chat-only) | ✅ |
| Multi-line autocomplete | ⚠️ Single completion span, no explicit multi-line ranking | ✅ | ❌ | ✅ |
| Next Edit Suggestions (NES) | ❌ | ❌ | ❌ | ✅ |
| Partial word accept (Ctrl+→) | ❌ (VS Code's native ghost-text partial-accept may still apply) | ✅ | ❌ | ✅ |
| Debounced + cached requests | ✅ (500ms debounce, 30s cache) | — | — | — |

> [!IMPORTANT]
> **Correction from the previous version of this doc:** inline completion was listed as entirely absent. It exists — `CodePartnerInlineCompletionProvider`, registered as a real `vscode.InlineCompletionItemProvider`, toggleable via `codepartner.toggleInlineCompletions` (default **off**, `codepartner.inlineCompletions` setting). It was previously **silently broken** for every cloud provider (it read the API key from a settings path that had been migrated to secure storage, so the key was always empty) — that's now fixed. Still genuinely behind Copilot on Next Edit Suggestions and explicit partial-word accept.

---

### 2.2 Chat & Agentic Capabilities

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Sidebar chat | ✅ | ✅ | ✅ | ✅ |
| Streaming responses | ✅ | ✅ | ✅ | ✅ |
| Thinking/reasoning display | ✅ | ✅ | ✅ | ✅ |
| Multi-turn agentic loop | ✅ (15 iters) | ✅ (unlimited) | ✅ (unlimited) | ✅ |
| Sub-agents: separate context + scoped tools | ✅ | ✅ (advanced, multi-workspace) | ✅ (background agents) | ✅ (parallel subagents) |
| Sub-agents: true filesystem isolation (branch/worktree per agent) | ✅ | ? not verified | ? not verified | ? not verified |
| Tool use / function calling | ✅ (25 built-in tools + MCP tools) | ✅ (30+ tools) | ✅ (20+ tools) | ✅ (extensible via MCP) |
| Action approval / permission gating | ✅ (4-tier policy, session allow-list, prompt-injection override) | ? not verified | ? not verified | ? not verified |
| Planning mode | ✅ (structured JSON checklist) | ✅ | ✅ | ✅ |
| Fast/direct mode | ✅ | ✅ | ✅ | ✅ |
| Architect/draft mode | ✅ (with per-hunk accept/reject) | ✅ | ❌ | ❌ |
| Cancel/stop generation | ✅ | ✅ | ✅ | ✅ |

> [!IMPORTANT]
> **Correction:** sub-agents ("basic" in the previous version) are now a real multi-turn, tool-using loop — each gets its own message history and a tool set scoped to its role (researcher/code_expert/tester/writer), not a single blocking completion. On top of that, `run_parallel_agents` runs 2–8 sub-agents concurrently, each in a fully isolated git worktree + branch, so they can safely edit the *same* files without conflicting — closer to Cursor's "N agents per branch" model than to a shared-workspace parallel run. I could not verify whether any of the three competitors offer true filesystem-level isolation (vs. just concurrent tool calls in the same workspace), so those cells are marked unverified rather than guessed.

> [!NOTE]
> CodePartner's agentic loop is still capped at **15 iterations** (sub-agent loops are separately capped at 6, deliberately smaller since their tasks should be narrower). Competitors reportedly allow unlimited autonomous loops — unchanged from the prior assessment.

> [!TIP]
> **New since the last version:** a permission system gates shell commands, file writes, and git operations behind a configurable policy (always-ask / ask-for-shell / full-auto / a deliberately-hard-to-enable "no confirmations" mode), with a session allow-list so routine commands don't re-prompt every turn, and a heuristic that forces confirmation on any tool call whose content closely echoes text pulled from web search / indexed docs / an `@`-mentioned file (basic prompt-injection mitigation). Also new: a regex-based scan warns (doesn't silently strip) when file or terminal content that looks like a credential is about to be sent to the model.

---

### 2.3 File & Code Operations

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Read file | ✅ | ✅ | ✅ | ✅ |
| Search/replace edit | ✅ (refuses ambiguous multi-match edits instead of guessing) | ✅ (multi-chunk) | ✅ | ✅ |
| Create file | ✅ | ✅ | ✅ | ✅ |
| Grep/regex search | ✅ | ✅ | ✅ | ✅ |
| Diff view (before/after) | ✅ | ✅ | ✅ | ✅ |
| Approve/reject per-file | ✅ | ✅ | ✅ | ✅ |
| **Approve/reject per-hunk** | ✅ | ? not verified | ? not verified | ? not verified |
| Undo/revert tool actions | ✅ (timeline + git-checkpoint fallback) | ✅ | ❌ | ❌ |
| Multi-file batch edits | ✅ Sequential (main agent) **+** true parallel isolated (via `run_parallel_agents`) | ✅ Parallel | ✅ Parallel | ✅ Parallel |
| File backup before edit | ✅ (now correctly restorable after a VS Code restart) | ✅ | ✅ | ✅ |

> [!IMPORTANT]
> **Correction:** revert/undo was previously broken after a VS Code restart — the backup data was being saved, but never read back in, so the Timeline's revert button had nothing to act on post-reload even though the data existed. Fixed, and backed by a second, independent fallback: a git checkpoint taken at the start of each turn (when the workspace is a git repo) that can restore a file even if the primary backup is somehow missing.

> [!TIP]
> Per-hunk review is new: Architect Mode drafts now render as individual hunks with accept/reject checkboxes, not just a whole-file approve/reject — "Apply Selected Hunks" alongside the original "Apply All Drafts." I could not verify whether the three competitors offer hunk-level (vs. file-level) review, so those cells are marked unverified.

---

### 2.4 Context & Awareness

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Active file context | ✅ | ✅ | ✅ | ✅ |
| Selection context | ✅ | ✅ | ✅ | ✅ |
| `@file` mentions | ✅ (cached file listing, debounced suggestions) | ✅ | ✅ | ✅ |
| `@workspace` scan | ✅ (TF-IDF ranked, not naive substring matching) | ✅ (semantic embeddings) | ✅ (full codebase index) | ✅ (semantic index) |
| `@web` search | ✅ (DuckDuckGo) | ✅ (Google Search) | ✅ (web browsing) | ✅ (Bing) |
| Semantic/embedding search | ⚠️ TF-IDF (term-frequency ranked), not neural embeddings | ✅ | ✅ | ✅ |
| Multi-file open tabs context | ✅ | ✅ | ✅ | ✅ |
| Context compaction | ✅ (message-count **and** estimated-token-count triggers) | ✅ | ✅ | ✅ (`/compact`) |
| Token-aware context budgeting | ✅ (shared budget across file mentions, active file, open tabs; replaces old fixed character caps) | ? not verified | ? not verified | ? not verified |
| Auto-loaded skills (keyword-matched to the prompt) | ✅ | ? not verified | ? not verified | ? not verified |
| MCP server integration | ✅ (client — connects to configured external MCP servers) | ❌ | ✅ | ✅ |
| Image/screenshot context | ✅ | ✅ | ✅ (Computer Use) | ✅ |

> [!IMPORTANT]
> **Corrections, three of them:**
> - `@workspace` is not naive keyword/line matching — it's a real TF-IDF index (term-frequency / inverse-document-frequency ranking). Better than substring search, but it's statistical term matching, not neural embeddings, so it won't catch a synonym or paraphrase the way true embedding search can — hence "⚠️ Partial," not a flat ✅.
> - Context compaction exists and is triggered on **both** message count and an estimated token count (a handful of very large messages used to be able to blow past useful context before the count-based trigger fired).
> - MCP support exists — CodePartner connects to external MCP servers configured via `.codepartner/mcp.json`, and their tools get merged into the main tool list. Previously listed as entirely absent.

> [!TIP]
> Also new: skills (reusable saved instructions) can now auto-load based on a keyword-overlap match against the current prompt, instead of requiring the model to remember to look them up.

---

### 2.5 Terminal & Command Execution

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Run shell commands | ✅ (spawned process, streamed, real timeout+kill) | ✅ | ✅ (native terminal) | ✅ |
| Command output capture | ✅ (exit code + stdout/stderr) | ✅ | ✅ | ✅ |
| Interactive terminal | ❌ | ✅ | ✅ (core feature) | ✅ |
| Auto-detect test runner | ✅ (async, streamed progress, cancellable) | ✅ | ✅ | ✅ |
| Terminal inline assist | ❌ | ✅ | ✅ | ✅ |

> [!NOTE]
> Mechanically reworked but not newly *featured*: command/test execution used to run through a VS Code terminal + temp-file-polling hack that could return truncated output on a slow-but-fine command, or hang the extension for up to 60s during a test run. Now a direct spawned process, streamed, with a real timeout that kills a hung process rather than just giving up watching it. Interactive terminal and inline terminal assist are still gaps, unchanged.

---

### 2.6 Git Integration

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Git status | ✅ | ✅ | ✅ | ✅ |
| Stage changes | ✅ | ✅ | ✅ | ✅ |
| Commit with message | ✅ | ✅ | ✅ | ✅ |
| Auto-generate commit msg | ✅ | ✅ | ✅ | ✅ |
| Create branch | ✅ | ✅ | ✅ | ✅ |
| Create PR | ✅ | ❌ | ✅ | ✅ (cloud agent) |
| Isolated parallel branches (worktree-per-agent) | ✅ | ? not verified | ? not verified | ? not verified |
| AI co-author tag | ❌ | ❌ | ❌ | ✅ |

> [!IMPORTANT]
> **Correction:** PR creation exists — push current branch (setting upstream if needed) + create a GitHub PR via the REST API. It was already implemented but had two real bugs that would have hit exactly the workflow it's built around: pushing a *brand-new* branch (the common branch → commit → PR sequence) could fail because the push didn't request an upstream, and the GitHub URL parser truncated any repository name containing a dot. Both fixed.

---

### 2.7 Browser & Research

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Browser navigate | ✅ (Puppeteer) | ✅ (built-in) | ✅ (Computer Use) | ❌ |
| Screenshot capture | ✅ | ✅ | ✅ | ❌ |
| Click / type / interact | ✅ | ✅ | ✅ | ❌ |
| Web search tool | ✅ | ✅ | ✅ | ✅ |
| Doc indexing / knowledge | ✅ (with secret-pattern scanning before indexed content reaches a prompt) | ✅ (Knowledge Items) | ✅ | ❌ |

> [!TIP]
> Unchanged from the prior assessment — still a genuine advantage over Copilot, which has no browser capability at all.

---

### 2.8 UI/UX Quality

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Glassmorphism/premium UI | ✅ | ✅ | ❌ (terminal) | ✅ (VS Code native) |
| Tabbed panel (Plan/Skills/etc.) | ✅ | ✅ (Artifact panel) | ❌ | ✅ |
| Timeline/action history | ✅ (accurate success/fail status, exit codes, duration — previously a failed command or failing test could show as green) | ✅ | ✅ | ✅ (debug log) |
| Progress bar for plans | ✅ (now actually populated — see note) | ✅ | ❌ | ❌ |
| Feedback (like/dislike) | ✅ | ❌ | ❌ | ✅ |
| Code block actions (Apply/Insert/Copy/Diff) | ✅ | ✅ | N/A | ✅ |
| Chat history (persist/rename/delete) | ✅ | ✅ | ✅ | ✅ |
| Model selector dropdown | ✅ (now shows context window size per model, e.g. "128k ctx") | ✅ | ❌ (config) | ✅ |
| Skill suggestion banner | ✅ (skills can now also silently auto-load, not just get suggested) | ❌ | ❌ | ❌ |
| Session token usage indicator | ✅ (real token counts from provider usage data, status bar) | ? not verified | ? not verified | ? not verified |
| Correct light/dark theme adaptation | ✅ (was broken — see note) | — | — | — |
| Keyboard shortcuts | ⚠️ Minimal (2 bindings) | ✅ Extensive | ✅ Extensive | ✅ Extensive |
| Drag-and-drop files | ❌ | ✅ | ❌ | ✅ |

> [!IMPORTANT]
> **Two real bugs found and fixed, both worth knowing about:**
> - The Plan panel's progress bar/checklist was fully built and wired up, but nothing ever populated it — the parser meant to feed it was dead code, never called anywhere. The model now sets the checklist directly (`create_plan`/`update_plan_task`) instead of the old, never-invoked markdown-parsing path.
> - Every translucent panel background in the webview (timeline, plan, drafts, and the main chat chrome) was rendered using a CSS custom property that was referenced but never defined, so every one of them silently fell back to its hardcoded **dark** color regardless of the user's actual VS Code theme — meaning light-theme users were plausibly seeing dark, low-contrast panels throughout. Fixed by computing real theme colors from the live theme and recomputing on a live theme switch.

---

### 2.9 Extensibility & Ecosystem

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Skills / custom instructions | ✅ (global `~/.codepartner`, now with keyword auto-load) | ✅ (Knowledge Items) | ✅ (`SKILL.md`) | ✅ (`.agent.md`) |
| MCP server support | ✅ | ❌ | ✅ | ✅ |
| Agent plugins marketplace | ❌ | ❌ | ❌ | ✅ (`@agentPlugins`) |
| Custom agent definitions | ❌ | ❌ | ✅ | ✅ (`.agent.md`) |
| Cloud/async agent execution | ❌ | ❌ | ✅ (Background Agents) | ✅ (Cloud Agent via GH Actions) |
| Remote control / mobile | ❌ | ❌ | ✅ | ✅ (experimental) |
| CI/CD integration | ❌ | ❌ | ✅ | ✅ |

> [!IMPORTANT]
> **Correction:** MCP client support exists (see §2.4) — this whole row for CodePartner was wrong in the previous version.

---

## 3. Provider & Model Support

| Provider | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| OpenAI / Azure OpenAI | ✅ | ❌ | ❌ | ✅ (built-in) |
| Anthropic (Claude) | ✅ | ✅ | ✅ (native) | ✅ |
| Google (Gemini) | ✅ | ✅ (native) | ❌ | ✅ |
| Ollama (local) | ✅ | ❌ | ❌ | ❌ |
| Custom / OpenAI-compatible | ✅ | ❌ | ❌ | ❌ |
| Dynamic model list fetch | ✅ | ✅ | N/A | ✅ |
| Consistent request-building across providers | ✅ (previously three separate, drifted implementations — one had a stray field in every Azure request, and Google/Ollama requests could silently break in one of the three call sites) | — | — | — |

> [!TIP]
> Unchanged strength: broadest provider support of any tool in this comparison.

> [!NOTE]
> Not a new *feature*, but worth knowing: the provider request-building logic (URL/headers/body per provider) used to be independently duplicated in three places and had quietly drifted out of sync — one path left a stray field in every Azure request, and another had no dedicated Google/Ollama handling at all, meaning a context-compaction call for those two providers could break in ways a normal chat request wouldn't. Now unified behind one implementation all three call sites share.

---

## 4. Missing Features — Prioritized Gap Analysis

### 🔴 Critical (High-impact, industry-standard)

| # | Feature | Available In | Status |
|:--|:---|:---|:---|
| 1 | ~~Inline code completion~~ | Copilot, Antigravity | **Resolved** — exists (and a bug that silently broke it for cloud providers is fixed) |
| 2 | True embedding/vector `@workspace` search | Antigravity, Claude Code, Copilot | **Still a gap** — CodePartner uses TF-IDF, which is real ranking (not naive keyword match) but not neural embeddings |
| 3 | ~~MCP support~~ | Claude Code, Copilot | **Resolved** — client support exists |
| 4 | ~~Context window compaction~~ | Antigravity, Claude Code, Copilot | **Resolved** — exists, with a token-aware trigger |
| 5 | ~~Multi-file open tabs as context~~ | Antigravity, Claude Code, Copilot | **Resolved** — exists |

### 🟡 Important (Competitive differentiators)

| # | Feature | Available In | Status |
|:--|:---|:---|:---|
| 6 | Next Edit Suggestions (NES) | Copilot | Still a gap |
| 7 | Cloud/async agent execution | Copilot, Claude Code | Still a gap |
| 8 | Custom agent definitions (`.agent.md`) | Copilot, Claude Code | Still a gap |
| 9 | ~~Parallel sub-agent execution~~ | Copilot, Antigravity | **Resolved, and arguably exceeded** — sub-agents are now real multi-turn tool-users, and `run_parallel_agents` gives true git-worktree filesystem isolation per agent, which I couldn't confirm any of the three competitors do |
| 10 | Interactive terminal integration | Antigravity, Claude Code, Copilot | Still a gap |
| 11 | ~~PR creation & review~~ | Claude Code, Copilot | **Resolved** — exists (two real bugs in it fixed) |
| 12 | Agent debug log / diagnostic panel | Copilot, Antigravity | Partial — an output channel exists; no dedicated diagnostic UI panel |
| 13 | Drag-and-drop file attachment | Copilot, Antigravity | Still a gap |

### 🟢 Nice-to-Have (Polish & ecosystem)

| # | Feature | Available In | Status |
|:--|:---|:---|:---|
| 14 | Keyboard shortcut system | Antigravity, Claude Code, Copilot | Still minimal (2 bindings) |
| 15 | AI co-author on Git commits | Copilot | Still a gap |
| 16 | Remote session control (mobile) | Claude Code, Copilot | Still a gap |
| 17 | Agent plugins marketplace | Copilot | Still a gap |
| 18 | CI/CD pipeline integration | Claude Code, Copilot | Still a gap |
| 19 | Slash commands (`/fix`, `/explain`, `/test`) | Copilot | Still a gap |
| 20 | Code referencing / license detection | Copilot | Still a gap |
| 21 | Finish Changes (context-aware completion) | Antigravity (Gemini) | Still a gap |

---

## 5. What CodePartner Does Better

| Strength | Detail |
|:---|:---|
| 🌐 **Broadest provider support** | 5 providers + Ollama + any OpenAI-compatible endpoint, now behind one consistent, unified request-building path. |
| 💰 **Zero subscription cost** | BYO API key means no monthly fee — just pay-per-token. |
| 🔒 **Offline/local AI** | Ollama support enables fully offline, private coding. |
| 🔐 **Credential hygiene** | API keys live in OS-level secure storage, never in `settings.json`; file/terminal content is scanned for likely secrets before it reaches a prompt. |
| 🚦 **Permission system** | Configurable approval policy for shell/file/git actions, a session allow-list, and a heuristic guard against prompt-injection-triggered tool calls — none of this existed in the prior version of this document. |
| 🧠 **Auto-loading skills** | Skills now match against the prompt automatically, not just a suggestion banner. |
| ⏪ **Timeline with undo, now actually durable** | Per-action undo that survives a VS Code restart, backed by a git-checkpoint fallback. Copilot and Claude Code don't have this. |
| 🏗️ **Architect mode, per-hunk review** | Draft changes without applying, then accept/reject individual hunks — not just whole files. |
| 📦 **Global skill persistence** | Skills stored in `~/.codepartner` travel across all projects. |
| 🌐 **Browser automation** | Puppeteer-based browser control that Copilot completely lacks. |
| 🔀 **Isolated parallel agents** | `run_parallel_agents` runs several agents concurrently, each in its own git worktree/branch — true filesystem isolation, not just concurrent API calls into a shared workspace. |
| 💬 **Feedback system** | Built-in bug report / feature request modal with email integration. |

---

## 6. Summary Verdict

```
CodePartner:  ███████████░░░░  ~72% feature parity  (up from ~55%)
Antigravity:  █████████████░░  ~87% (standalone IDE advantage)
Claude Code:  ████████████░░░  ~80% (CLI + multi-surface)
Copilot:      ██████████████░  ~93% (deepest VS Code integration)
```

The jump from ~55% to ~72% is mostly **correcting a previous undercount**, not new feature work landing since: inline completion, MCP, context compaction, multi-tab context, and PR creation were already implemented but marked absent in the last version of this document. The genuinely new capabilities are the permission/approval system, real (not single-shot) sub-agents with true filesystem-isolated parallel runs, per-hunk diff review, and the credential-hygiene work — none of which existed as line items before.

> [!IMPORTANT]
> **What's still the real gap list**, now that the false negatives are corrected:
> 1. True embedding/vector search for `@workspace` (TF-IDF is a real improvement over naive matching, but it's not the same thing)
> 2. Next Edit Suggestions and interactive-terminal-level editor integration
> 3. Custom agent definitions and a plugin marketplace
> 4. Cloud/async execution that survives closing the editor, and remote/mobile control
> 5. Slash commands and a lighter keyboard-shortcut gap

---

## Changelog note

This revision cross-checked every CodePartner-side claim in the original document directly against the current source (not from memory or the original doc's assumptions), and found:
- **5 outright incorrect "missing" markings** (inline completion, MCP, context compaction, multi-tab context, PR creation — all existed)
- **1 overstated claim** (`@workspace` "semantic search" is TF-IDF, not embeddings — now marked ⚠️ rather than either ✅ or ❌)
- **3 real bugs** found and fixed in the process: inline completion silently non-functional for every cloud provider, the Plan panel's progress UI never actually receiving data, and every translucent panel in the webview ignoring the user's actual light/dark theme
- Competitor-side cells are unchanged from the original document — I have no way to verify Antigravity/Claude Code/Copilot's internals, so anything I couldn't confirm about *them* is left as originally written, or marked "not verified" where a new CodePartner capability invited a direct comparison.
