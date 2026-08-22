# CodePartner vs. Antigravity / Claude Code / GitHub Copilot

A deep-dive comparison based on CodePartner v1.2.2 source code analysis and current competitor capabilities (May 2026).

---

## 1. Architecture Overview

| Aspect | CodePartner | Antigravity (Google) | Claude Code (Anthropic) | GitHub Copilot |
|:---|:---|:---|:---|:---|
| **Form Factor** | VS Code sidebar extension | Standalone IDE (VS Code fork) | CLI tool + VS Code + Desktop + Browser | Built-in to VS Code |
| **Runtime** | Single extension process | Full IDE with Agent Manager | Multi-surface (terminal, IDE, cloud) | VS Code native + cloud agents |
| **Codebase** | ~2,700 LOC TypeScript + 1,300 LOC JS | Full IDE application | Enterprise-grade Rust/Python | Microsoft-backed platform |
| **API Approach** | BYO API key (multi-provider) | Google models + 3rd party | Anthropic API (subscription) | GitHub subscription |
| **Offline Support** | ✅ Via Ollama | ❌ Cloud-only | ❌ Cloud-only | ❌ Cloud-only |

> [!TIP]
> CodePartner's BYO-key + Ollama model is a **unique strength** — none of the competitors offer true local/offline AI without a subscription.

---

## 2. Core Feature Comparison

### 2.1 Inline Code Completion (Ghost Text)

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Tab-complete ghost text | ❌ | ✅ | ❌ (chat-only) | ✅ |
| Multi-line autocomplete | ❌ | ✅ | ❌ | ✅ |
| Next Edit Suggestions (NES) | ❌ | ❌ | ❌ | ✅ |
| Partial word accept (Ctrl+→) | ❌ | ✅ | ❌ | ✅ |

> [!IMPORTANT]
> **This is the #1 missing feature.** Copilot and Antigravity provide real-time inline completions as you type. CodePartner has zero inline completion support — it is purely chat/sidebar-based. This alone is the biggest differentiator for day-to-day productivity.

---

### 2.2 Chat & Agentic Capabilities

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Sidebar chat | ✅ | ✅ | ✅ | ✅ |
| Streaming responses | ✅ | ✅ | ✅ | ✅ |
| Thinking/reasoning display | ✅ | ✅ | ✅ | ✅ |
| Multi-turn agentic loop | ✅ (15 iters) | ✅ (unlimited) | ✅ (unlimited) | ✅ |
| Parallel sub-agents | ✅ (basic) | ✅ (advanced, multi-workspace) | ✅ (background agents) | ✅ (parallel subagents) |
| Tool use / function calling | ✅ (16 tools) | ✅ (30+ tools) | ✅ (20+ tools) | ✅ (extensible via MCP) |
| Planning mode | ✅ | ✅ | ✅ | ✅ |
| Fast/direct mode | ✅ | ✅ | ✅ | ✅ |
| Architect/draft mode | ✅ | ✅ | ❌ | ❌ |
| Cancel/stop generation | ✅ | ✅ | ✅ | ✅ |

> [!NOTE]
> CodePartner's agentic loop is capped at **15 iterations** — competitors allow unlimited autonomous loops. This limits complex multi-file refactoring tasks.

---

### 2.3 File & Code Operations

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Read file | ✅ | ✅ | ✅ | ✅ |
| Search/replace edit | ✅ | ✅ (multi-chunk) | ✅ | ✅ |
| Create file | ✅ | ✅ | ✅ | ✅ |
| Grep/regex search | ✅ | ✅ | ✅ | ✅ |
| Diff view (before/after) | ✅ | ✅ | ✅ | ✅ |
| Approve/reject per-file | ✅ | ✅ | ✅ | ✅ |
| Undo/revert tool actions | ✅ (timeline) | ✅ | ❌ | ❌ |
| Multi-file batch edits | ⚠️ Sequential only | ✅ Parallel | ✅ Parallel | ✅ Parallel |
| File backup before edit | ✅ | ✅ | ✅ | ✅ |

---

### 2.4 Context & Awareness

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Active file context | ✅ | ✅ | ✅ | ✅ |
| Selection context | ✅ | ✅ | ✅ | ✅ |
| `@file` mentions | ✅ | ✅ | ✅ | ✅ |
| `@workspace` scan | ✅ (keyword) | ✅ (semantic embeddings) | ✅ (full codebase index) | ✅ (semantic index) |
| `@web` search | ✅ (DuckDuckGo) | ✅ (Google Search) | ✅ (web browsing) | ✅ (Bing) |
| Semantic/embedding search | ❌ | ✅ | ✅ | ✅ |
| Multi-file open tabs context | ❌ | ✅ | ✅ | ✅ |
| Context compaction | ❌ | ✅ | ✅ | ✅ (`/compact`) |
| MCP server integration | ❌ | ❌ | ✅ | ✅ |
| Image/screenshot context | ✅ | ✅ | ✅ (Computer Use) | ✅ |

> [!WARNING]
> **Semantic search is a critical gap.** CodePartner's `@workspace` uses naive keyword matching against file lines. Competitors use embedding-based vector search for dramatically better relevance. CodePartner also lacks MCP support, which is becoming an industry standard.

---

### 2.5 Terminal & Command Execution

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Run shell commands | ✅ | ✅ | ✅ (native terminal) | ✅ |
| Command output capture | ✅ | ✅ | ✅ | ✅ |
| Interactive terminal | ❌ | ✅ | ✅ (core feature) | ✅ |
| Auto-detect test runner | ✅ | ✅ | ✅ | ✅ |
| Terminal inline assist | ❌ | ✅ | ✅ | ✅ |

---

### 2.6 Git Integration

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Git status | ✅ | ✅ | ✅ | ✅ |
| Stage changes | ✅ | ✅ | ✅ | ✅ |
| Commit with message | ✅ | ✅ | ✅ | ✅ |
| Auto-generate commit msg | ✅ | ✅ | ✅ | ✅ |
| Create branch | ✅ | ✅ | ✅ | ✅ |
| Create PR | ❌ | ❌ | ✅ | ✅ (cloud agent) |
| AI co-author tag | ❌ | ❌ | ❌ | ✅ |

---

### 2.7 Browser & Research

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Browser navigate | ✅ (Puppeteer) | ✅ (built-in) | ✅ (Computer Use) | ❌ |
| Screenshot capture | ✅ | ✅ | ✅ | ❌ |
| Click / type / interact | ✅ | ✅ | ✅ | ❌ |
| Web search tool | ✅ | ✅ | ✅ | ✅ |
| Doc indexing / knowledge | ✅ (basic) | ✅ (Knowledge Items) | ✅ | ❌ |

> [!TIP]
> CodePartner's browser control via Puppeteer is a genuine competitive advantage over Copilot, which has no browser capability at all.

---

### 2.8 UI/UX Quality

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Glassmorphism/premium UI | ✅ | ✅ | ❌ (terminal) | ✅ (VS Code native) |
| Tabbed panel (Plan/Skills/etc.) | ✅ | ✅ (Artifact panel) | ❌ | ✅ |
| Timeline/action history | ✅ | ✅ | ✅ | ✅ (debug log) |
| Progress bar for plans | ✅ | ✅ | ❌ | ❌ |
| Feedback (like/dislike) | ✅ | ❌ | ❌ | ✅ |
| Code block actions (Apply/Insert/Copy/Diff) | ✅ | ✅ | N/A | ✅ |
| Chat history (persist/rename/delete) | ✅ | ✅ | ✅ | ✅ |
| Model selector dropdown | ✅ | ✅ | ❌ (config) | ✅ |
| Skill suggestion banner | ✅ | ❌ | ❌ | ❌ |
| Keyboard shortcuts | ⚠️ Minimal | ✅ Extensive | ✅ Extensive | ✅ Extensive |
| Drag-and-drop files | ❌ | ✅ | ❌ | ✅ |

---

### 2.9 Extensibility & Ecosystem

| Feature | CodePartner | Antigravity | Claude Code | Copilot |
|:---|:---:|:---:|:---:|:---:|
| Skills / custom instructions | ✅ (global `~/.codepartner`) | ✅ (Knowledge Items) | ✅ (`SKILL.md`) | ✅ (`.agent.md`) |
| MCP server support | ❌ | ❌ | ✅ | ✅ |
| Agent plugins marketplace | ❌ | ❌ | ❌ | ✅ (`@agentPlugins`) |
| Custom agent definitions | ❌ | ❌ | ✅ | ✅ (`.agent.md`) |
| Cloud/async agent execution | ❌ | ❌ | ✅ (Background Agents) | ✅ (Cloud Agent via GH Actions) |
| Remote control / mobile | ❌ | ❌ | ✅ | ✅ (experimental) |
| CI/CD integration | ❌ | ❌ | ✅ | ✅ |

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

> [!TIP]
> CodePartner has the **broadest provider support** of any tool in this comparison. Supporting 5 providers + any OpenAI-compatible endpoint + Ollama local is a significant advantage for flexibility and cost control.

---

## 4. Missing Features — Prioritized Gap Analysis

### 🔴 Critical (High-impact, industry-standard)

| # | Feature | Available In | Impact |
|:--|:---|:---|:---|
| 1 | **Inline code completion (ghost text / tab-complete)** | Copilot, Antigravity | Massive daily productivity gap |
| 2 | **Semantic/embedding workspace search** | All three competitors | Much better `@workspace` relevance |
| 3 | **MCP (Model Context Protocol) support** | Claude Code, Copilot | Industry standard for tool extensibility |
| 4 | **Context window compaction** | All three competitors | Prevents failures on long conversations |
| 5 | **Multi-file open tabs as context** | All three competitors | Better code awareness without `@file` |

### 🟡 Important (Competitive differentiators)

| # | Feature | Available In | Impact |
|:--|:---|:---|:---|
| 6 | **Next Edit Suggestions (NES)** | Copilot | Predict where + what to change next |
| 7 | **Cloud/async agent execution** | Copilot, Claude Code | Work continues after closing IDE |
| 8 | **Custom agent definitions (`.agent.md`)** | Copilot, Claude Code | Repo-scoped agent behaviors |
| 9 | **Parallel sub-agent execution** | Copilot, Antigravity | Faster complex task completion |
| 10 | **Interactive terminal integration** | All three competitors | Run commands in VS Code terminal panel |
| 11 | **PR creation & review** | Copilot, Claude Code | End-to-end Git workflow |
| 12 | **Agent debug log / diagnostic panel** | Copilot, Antigravity | Better troubleshooting for developers |
| 13 | **Drag-and-drop file attachment** | Copilot, Antigravity | Easier file context addition |

### 🟢 Nice-to-Have (Polish & ecosystem)

| # | Feature | Available In | Impact |
|:--|:---|:---|:---|
| 14 | **Keyboard shortcut system** | All three competitors | Power user efficiency |
| 15 | **AI co-author on Git commits** | Copilot | Attribution tracking |
| 16 | **Remote session control (mobile)** | Claude Code, Copilot | Monitor tasks on the go |
| 17 | **Agent plugins marketplace** | Copilot | Community-driven extensibility |
| 18 | **CI/CD pipeline integration** | Claude Code, Copilot | Automated testing/deployment |
| 19 | **Slash commands (`/fix`, `/explain`, `/test`)** | Copilot | Quick-action shortcuts |
| 20 | **Code referencing / license detection** | Copilot | IP compliance |
| 21 | **Finish Changes (context-aware completion)** | Antigravity (Gemini) | Observe partial edits and finish them |

---

## 5. What CodePartner Does Better

Despite the gaps, CodePartner has genuine advantages:

| Strength | Detail |
|:---|:---|
| 🌐 **Broadest provider support** | 5 providers + Ollama + any OpenAI-compatible endpoint. No competitor matches this. |
| 💰 **Zero subscription cost** | BYO API key means no monthly fee — just pay-per-token. |
| 🔒 **Offline/local AI** | Ollama support enables fully offline, private coding. |
| 🧠 **Proactive skill discovery** | Auto-suggests saving workflows as reusable skills — unique feature. |
| ⏪ **Timeline with undo** | Per-action undo in the timeline panel. Copilot and Claude Code don't have this. |
| 🏗️ **Architect mode** | Draft changes without applying — unique 3rd mode beyond fast/plan. |
| 📦 **Global skill persistence** | Skills stored in `~/.codepartner` travel across all projects. |
| 🌐 **Browser automation** | Puppeteer-based browser control that Copilot completely lacks. |
| 💬 **Feedback system** | Built-in bug report / feature request modal with email integration. |

---

## 6. Summary Verdict

```
CodePartner:  ████████░░░░░░░  ~55% feature parity
Antigravity:  █████████████░░  ~87% (standalone IDE advantage)
Claude Code:  ████████████░░░  ~80% (CLI + multi-surface)  
Copilot:      ██████████████░  ~93% (deepest VS Code integration)
```

**CodePartner's biggest competitive moat** is provider flexibility and zero subscription cost. Its biggest gap is the complete absence of inline code completions, which is what most developers interact with dozens of times per hour.

> [!IMPORTANT]
> **Recommended priority for next releases:**
> 1. Add inline code completion provider (even basic ghost text)
> 2. Implement semantic workspace search with embeddings
> 3. Add MCP server support for extensibility
> 4. Implement context compaction for long sessions
> 5. Add slash commands for quick actions
