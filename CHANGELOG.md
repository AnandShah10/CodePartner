# Change Log

All notable changes to the **CodePartner AI** VS Code extension will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [2.8.1] - 2026-10-09
### Separate thinking UI
- Assistant messages keep **Thinking** in its own collapsible block above the answer (partial updates no longer wipe it)
- Stream parsing: OpenAI/DeepSeek `reasoning_content` / `reasoning`, Anthropic `thinking_delta`, Gemini `parts[].thought`
- Header label switches from **Thinking** → **Thought** when the turn completes

## [2.8.0] - 2026-10-09
### Auto-verify, richer NES, review packs
- **`autoVerify`**: after agent file edits, automatically run **focused** related tests (or full suite) without the model calling `run_tests`
- Settings: `codepartner.autoVerify` (off|focused|full), `autoVerifyMaxAttempts`
- **NES / Finish Changes**: case-variant rename (foo/Foo/FOO_BAR), import/path segment updates, repeated string-literal replace
- **Review policy packs**: security, react, node, quality (path-aware rules expanded)

## [2.7.0] - 2026-10-09
### Computer-use browser
- Local Chrome **observe → act → observe** loop (no cloud)
- New actions: **observe**, hover, select, scroll, press, evaluate, close
- `observe` returns interactive elements with CSS selectors + body text
- navigate/click/type auto-return a fresh observation
- screenshot saves artifact and includes a short observation
- Tool schema + system prompt updated for computer-use workflow

## [2.6.0] - 2026-10-09
### Multi-file transactional PatchSet + 3-way merge
- **`PatchTransaction`**: accumulates all `edit_file` / `create_file` in a turn; original pre content preserved across chained edits
- End of turn → **Accept all / Reject all / Review merges** (notification + Activity banner)
- **Reject** rolls back every file in the set (delete if agent-created)
- **Review** runs **3-way merge** (base=pre, ours=disk, theirs=agent); writes conflict markers; opens diffs for clean agent files
- Commands: `codepartner.acceptPatchSet`, `rejectPatchSet`, `reviewPatchSet`
- Modules: `patchSet.ts`, `merge3.ts`

## [2.5.0] - 2026-10-09
### Local sandbox
- Setting **`codepartner.sandboxMode`**: `off` | `soft` (default) | `strict`
- **soft**: command safety + filtered process env (strips KEY/TOKEN/SECRET/…) for `run_command` / tests
- **strict**: also **blocks** network/install shell patterns (`curl`, `wget`, `npm install`, `git clone`, …) unless yolo; on Linux uses **bubblewrap** when `bwrap` is installed
- Visible terminal still subject to allow/block policy (bubblewrap wrap applied to the sent command string)

## [2.4.12] - 2026-10-09
### Symbols / patches
- **DocumentSymbol enrichment** via VS Code language extensions (TS/JS when available)
- **`patchSet.ts`** — structured file patches; timeline stores `patchRegions` for edits

## [2.4.11] - 2026-09-28
### Prompt-injection / multi-root
- **Browser tool results** tracked as untrusted content
- BrowserManager root refreshed when workspace folders change

## [2.4.10] - 2026-09-28
### Prompt-injection
- **MCP tool results** tracked as untrusted content (forces approval when args echo MCP output)

## [2.4.9] - 2026-09-28
### Write safety
- **Per-path write locks** (`fileWriteLock.ts`) around edit_file / create_file
- Architect hunk apply uses **path containment**

## [2.4.8] - 2026-09-28
### Context freshness
- Symbol index **incremental update** on save (TS/JS/Vue/Svelte), debounced 400ms
- `SymbolIndex.updateFile` for multi-root paths

## [2.4.7] - 2026-09-28
### Verification loop depth
- Failed `run_tests` returns **[REVERIFY REQUIRED]** with exact command to re-run + related files
- Passed tests mark **[VERIFIED]**
- **`re_run_last_tests`** tool reuses the last test command
- Rebuild symbol/semantic indexes on **workspace folder** changes

## [2.4.6] - 2026-09-28
### Partial-feature depth
- **Symbol index multi-root** — indexes all workspace folders (paths prefixed by folder name)
- Richer symbol patterns (methods, export default, let/var)
- **Test guidance** suggests focused re-run when a single test file is detected
- More **review** rules (new Function, document.write, TLS rejectUnauthorized)
- Patch revert: undo pure agent **insertions** when still present

## [2.4.5] - 2026-09-28
### Approvals / UX
- High-risk shell patterns (**warn** level) always force an approval prompt (except yolo), bypassing full-auto / session allow-list
- Progress status: "Working: tools…" when scheduling; per-tool status (Reading/Editing/Running tests/…)

## [2.4.4] - 2026-09-28
### Local command safety
- `commandSafety.ts` — block catastrophic patterns (`rm -rf /`, mkfs, pipe-to-shell, fork bomb); warn on `rm -rf`, force-push, reset --hard
- Wired into `run_command` / `run_in_terminal` (blocks even under yolo for absolute dangers)

## [2.4.3] - 2026-09-28
### Structure
- Extracted **ArtifactRegistry**, **SkillManager**, **diff providers** to own modules
- System prompt rule: verification loop after substantive edits

## [2.4.2] - 2026-09-28
### Structure / local review
- Extracted **BrowserManager** → `browserManager.ts`, **TOOLS** → `tools.ts`
- **Lightweight code review hints** after edit/create (`codeReviewHints.ts`) — eval/XSS/secrets/TODO signals for the agent (no backend)

## [2.4.1] - 2026-09-28
### Structure / context
- Extracted **system prompts** to `systemPrompts.ts` (thin `extension.ts` split)
- **Git-recent boost** in context ranker (`boostByRecentGit` via `git log`)
- Comparison analysis note for roadmap progress

## [2.4.0] - 2026-09-28
### Context ranking
- `contextRanker.ts` — symbol-path boost + pack-to-budget for `@workspace` results
- README brought in line with roadmap work through 2.3.9

## [2.3.9] - 2026-09-28
### Model routing / durable local agents
- Setting `codepartner.completionModel` — optional faster model for inline completions (`modelRouter.ts`)
- Queued async agents **resume after reload** (running jobs still marked interrupted)

## [2.3.8] - 2026-09-28
### Multi-root
- `workspaceRoot.ts` — prefer folder of active editor over always folder[0]
- File/shell tools and context use preferred root
- Multi-root workspace summary injected into agent context

## [2.3.7] - 2026-09-28
### UX
- Sidebar simplified to **Chat | Plan | Activity**
- Activity sub-nav: Timeline · Artifacts · Terminal · Skills · Debug
- Tab labels on wider panels; hide labels when very narrow

## [2.3.6] - 2026-09-28
### Context / Verification
- Symbol context: **import-graph expansion** + definition snippet
- **Test failure parser** (`testFailureParse.ts`) — structured hints + guidance after failed `run_tests`
- Inline completion default debounce **200ms** (was 500)

## [2.3.5] - 2026-09-28
### Context (Roadmap Phase 2)
- **Symbol index** (`symbolIndex.ts`): lightweight TS/JS definition extraction
- Injects symbol hits into `@workspace` search and general prompts
- Unit tests for extraction

## [2.3.4] - 2026-09-28
### Runtime
- **Patch-aware Timeline revert** (`patchRevert.ts`): undoes agent regions without wiping later user edits when possible; stores `postContent` on timeline events
- Safer create-file revert (won't delete user-modified files)
- Path containment on revert paths

## [2.3.3] - 2026-09-28
### Security / Runtime
- Path containment extended to grep, license scan, code-reference scan, openFile
- **Tool scheduler** (`toolScheduler.ts`): serializes same-path writes and shell tools; parallel only when safe
- Scheduler unit tests

## [2.3.2] - 2026-09-28
### Security (Roadmap Phase 0)
- Capability-oriented tool gating: `send_terminal_input`, MCP tools (`external`), `browser_control`, `stage_git_changes`
- Workspace path containment (`pathSafety.ts`) on list/read/edit/create
- Secret **redaction** before model context (`redactSecretsInText`) in addition to warnings
- `docs/ROADMAP.md` committed

## [2.3.1] - 2026-09-28
### Fixed
- **Stop button**: sets a cancel latch, aborts the stream, kills shell/tests (SIGTERM then SIGKILL), skips remaining tools — no more commands after Stop.
- **Chat history**: opening an old chat no longer shows injected `--- Context ---` blocks or busy loaders; active turn is cancelled first.
- **Non-code files**: plan/walkthrough-style creates are routed to **Artifacts** instead of the repo root.

### Added
- **Prompt queue**: messages typed while a turn is running are queued and auto-sent after completion (clearable badge).
- **File tags**: Antigravity-style pill UI for `@file` and `/slash` mentions.
- **Async job persistence**: job list survives reload (running jobs marked interrupted).
- Setting `codepartner.llmNextEditSuggestions` (opt-in; pattern NES remains default).

## [2.3.0] - 2026-09-25
### Added
- **Local async agents** (`run_async_agent` / `list_async_agents`): background jobs in the extension host with progress notification (no cloud backend).
- **Git plugin catalog**: `codepartner.pluginCatalogRepo` + `sync_plugin_catalog` / **Sync Plugin Catalog** command; agents merge with `.codepartner/agents/*.md`.
- **CI tools** via `gh` CLI: `list_ci_runs`, `trigger_ci_workflow`, `write_ci_workflow` (plus existing `create_pull_request`).

## [2.2.1] - 2026-09-25
### Added
- **Agent Debug panel** (Diagnostics tab): session chips (mode, provider, model, tokens, plan progress), recent tools with success/fail, system log (info/warning/error).
- Thorough `logDiagnostic` coverage: API retries, tool failures, planning blocks, MCP init, attach/open errors, mode switches, fatal agent errors.
- Full log / Refresh / Clear actions on the debug panel.

## [2.2.0] - 2026-09-25
### Added
- **`scan_code_references` tool** + `codeReference.ts`: workspace similarity attribution (path, lines, score, license).
- **Full-repo NES**: workspace text search for remaining rename sites beyond open editors.
- **Sidebar Terminal tab**: run/interactive input from the webview; Focus panel button.

## [2.1.9] - 2026-09-25
### Added
- **Multi-file NES**: rename / repeated-line Finish Changes scan all open editors (not only the active file).
- **`send_terminal_input` tool**: type into the visible CodePartner terminal for interactive prompts/REPLs.
- **Focus Interactive Terminal** command (`codepartner.focusTerminal`, `Ctrl+Alt+\``).

## [2.1.8] - 2026-09-25
### Fixed
- **Drag-and-drop**: Larger input drop target (`min-height`) and full-area overlay so drops are not lost under child controls.
- **Planning mode**: Always produce plan + `create_plan` checklist without the user having to ask; stop and ask for **proceed** before any file mutations; clearer wait message pointing at Plan tab.
- **Task ticks**: Auto-mark Plan tasks done when a matching `@file` / filename is successfully edited or created; UI refresh on manual checkbox complete.

### Added
- **Next Edit Suggestions + Finish Changes** (`src/nextEdit.ts`): after a partial rename or identical-line edit, remaining sites are highlighted with CodeLens and status bar; apply next / finish all / dismiss commands and keybindings.
- **Slash command `/help`**: lists `/fix`, `/explain`, `/test`, `/compact`, `/clear`, and related shortcuts.
- **`scan_licenses` tool** + `licenseScanner.ts`: SPDX / common license-header scan across workspace sources.

### Changed
- Comparison analysis re-audited against `fix` branch (embeddings, terminal assist, co-author, custom agents, slash commands, keyboard shortcuts marked correctly).

## [2.1.7] - 2026-11-11
### Added
- **Terminal inline assist** (`codepartner.terminalInlineAssist` setting with values `disabled` / `codepartner-only` / `all-terminals`): When a terminal command fails, shows a dismissible notification offering to let CodePartner analyze the failure (command + output) and suggest fixes. "codepartner-only" limits to terminals launched via `run_in_terminal`; "all-terminals" watches every terminal in the workspace (requires explicit one-time user confirmation on first enable for privacy).
- Updated `terminalAssist.ts` with hardened `isFailureWorthAssisting()` / `shouldOfferAssist()` (explicit braces for ESLint `curly: "error"` rule) and improved `buildAssistPrompt()`.
- New configuration documentation and comparison analysis updates for the terminal assist feature.

### Changed
- Version bumped to **2.1.7** with full synchronization across `package.json`, README.md (badge, config table, final note), `codepartner_comparison_analysis.md` (removed terminal assist from gaps list, added to strengths), and this changelog.
- Configuration table in README expanded with the new terminal setting and updated descriptions.
- Comparison analysis refreshed to ~90% parity (terminal assist gap closed; inline completions, embeddings, custom agents, worktree isolation, per-hunk Architect, durable Timeline, MCP, approval system, permission gating all re-verified against current implementation).

### Fixed
- Minor version/doc drift from v2.1.6 release.
- ESLint compliance in terminal assist logic (all `if` statements now braced).
- Updated feature claims in README and analysis to accurately reflect the new terminal monitoring capability.

(See `src/terminalAssist.ts`, updated `extension.ts` tool descriptions, and test runner for full details.)

## [2.1.6] - 2026-11-10
### Added
- **Custom repo-scoped agents** (`.codepartner/agents/*.md` with YAML frontmatter): Define your own named agents using `name:`, `description:`, `tools:` (comma-separated), and the file body as the full system prompt. Strictly scoped to the repo (not global like Skills).
  - New `parseCustomAgentFile`, `resolveAgentTools`, `findUnknownAgentTools` in `src/customAgents.ts` (filename fallback, rejects empty/missing-frontmatter files, trims whitespace, set-intersection for tools, logs unknown tools for typo detection without failing)
  - Integration in `extension.ts`: `loadCustomAgents()`, `runCustomAgent()`, `listCustomAgentsTool` (graceful empty-dir fallback with helpful bootstrap message, added to `runAgentLoop` and parallel path, no extra persona wrapper)
  - New tools `list_custom_agents` / `call_custom_agent`
  - Comprehensive test suite in `customAgents.test.ts` for all parsing edge cases, tool resolution, unknown tools
- Documentation for custom agents in README (frontmatter example, usage, "no agents" behavior, Extension Development Host testing workflow)

### Changed
- Version, README badge/note, feature table, comparison analysis, and changelog synchronized to **2.1.6** (now accurately reflects implemented custom agent + terminal lint changes)

### Fixed
- Graceful degradation for missing `.codepartner/agents/` directory or invalid agent files (returns `[]` or explicit message)
- Docs parity for custom agents, embeddings, Architect Mode, Timeline, MCP, context compaction, approval system, hybrid search

(See full details in `customAgents.ts`, `extension.ts`, `terminalAssist.ts`, and tests.)

## [2.1.5] - 2026-11-09
### Changed
- Final lint compliance pass on terminal inline assistant (`src/terminalAssist.ts`): added braces to all `if` statements in `isFailureWorthAssisting()`, `shouldOfferAssist()`, updated `buildAssistPrompt` comment style
- ESLint `curly` rule upgraded `"warn"` → `"error"` in `eslint.config.mjs` (all 94 `if`/`for` bracing issues now resolved across entire codebase; no functional changes to core agent loop, embeddings, worktree isolation, approvals or Architect Mode)
- Pretest sequence and `.vscode-test.mjs` refined: pinned VS Code to ^1.93.0, increased Mocha timeout, added stability flags (GPU/extension disables) for CI-like reliability
- Version bumped to **2.1.5** with README badge/note/feature table and comparison analysis synchronized

### Added
- Robust test runner hardening for flaky `spawnSync cmd.exe ETIMEDOUT/ENOBUFS` (handles OneDrive paths, network, spaces/dashes in paths)

### Fixed
- Remaining `curly` lint violations specific to terminal assistant logic (failure detection, assist offer deduplication, prompt building)
- Test runner flakiness in pretest and CI environments
- Documentation parity for lint compliance, test stability, embeddings guidance, Architect Mode, Timeline undo, MCP, context compaction, approval system, and hybrid semantic search

## [2.1.4] - 2026-11-08
### Changed
- Version alignment across `package.json` (now **2.1.4**), README badge, CHANGELOG, and comparison analysis
- Documentation and feature notes refreshed to reflect stable v2.1.3 embeddings implementation now shipping in 2.1.4
- Updated "Smart Context" and configuration sections in README with clearer embeddings guidance

### Fixed
- 93 ESLint `curly` warnings (added consistent braces to all `if`/`for` statements in `embeddings.ts`, `semanticSearch.ts`, `extension.ts`, and supporting modules)
- Test runner flakiness (network timeout on `@vscode/test-electron` download during CI-like runs; pretest now succeeds cleanly)
- Minor version drift and doc inconsistencies from the embeddings rollout

## [2.1.3] - 2026-11-07
### Added
- Real **embedding-based semantic search** (`src/embeddings.ts` + upgraded `SemanticSearch`)
  - New config: `codepartner.embeddingProvider` (`disabled` / `same-as-chat` / `openai` / `azure` / `google` / `ollama`)
  - `codepartner.embeddingModel` and `codepartner.embeddingEndpoint` for full control
  - Automatic graceful fallback to TF-IDF on any error (bad key, network issue, Anthropic chat provider, etc.)
  - Chunking with overlap, content-hash caching, cosine similarity, batching where supported
  - Unit-tested request building, response parsing, similarity math, and chunking (network calls not testable in sandbox)
- Updated `semanticSearch.ts` to optionally use embeddings for `@workspace` (much better relevance than pure TF-IDF)
- Expanded configuration schema, README, and changelog to document the new semantic search upgrade path

### Changed
- `package.json` version bumped to **2.1.3**
- `SemanticSearch.search()` now tries embeddings first (when configured) and falls back transparently
- README "Smart Context" and configuration table refreshed with embedding options
- Version badge and final note in README updated

### Fixed
- Version alignment across package.json (2.1.3), README badge, and changelog top section

## [2.1.2] - 2026-11-06
### Added
- New commands: `codepartner.newChat` (Ctrl+Alt+N / Cmd+Alt+N) and `codepartner.cancelActiveTask` (Ctrl+Alt+X / Cmd+Alt+X)
- Enhanced keybindings for inline completions (accept next word/line) and all new commands
- Updated system prompts and tool descriptions to precisely match Architect Mode rules, parallel agent isolation, and critical guidelines (read-before-edit, complete implementations, explain reasoning, etc.)
- UI refinements in sidebar (media/main.css, main.js) for better glassmorphism, tabs, and task management

### Changed
- `run_parallel_agents` tool now explicitly documents full Git worktree + branch isolation for concurrent sub-agents
- `call_subagent` and `runInternalAgent` descriptions updated for clarity on shared vs. isolated workspaces
- `ARCHITECT_SYSTEM_PROMPT` and `BASE_SYSTEM` aligned with internal agent rules (no `run_command` in Architect mode, draft changes via `edit_file`)
- Inline completion provider improvements (`src/inlineCompletion.ts`)
- `package.json` version, commands, keybindings, and configuration fully synchronized

### Fixed
- Version drift between package.json (now **2.1.2**), README, and changelog
- Minor inconsistencies in tool call parsing, token budgeting in browser_control, and approval policy enforcement during parallel runs

## [2.1.1] - 2026-11-05
### Added
- Full production integration of `run_parallel_agents` with the `gitWorktree` module (isolated branches + worktrees for 2-8 concurrent sub-agents)
- Support for `runInternalAgent` multi-turn loops in sub-agents with scoped tools via `getScopedTools`
- Enhanced `AgentManager.dispatch` for parallel execution tracking and result aggregation
- New test coverage for parallel agent workflows and worktree cleanup

### Changed
- `extension.ts` refactored to import and use `createWorktree`/`removeWorktree`/`commitAllIfDirty` etc. in the parallel agent path
- Updated `run_parallel_agents` description to highlight isolation benefits vs. `call_subagent`
- Improved error recovery, status updates, and Timeline entries for parallel runs
- System prompts refined for better adherence to "Architect Mode" drafting behavior

### Fixed
- Race conditions in concurrent file edits (worktrees ensure independent checkouts)
- Approval policy application across sub-agents
- Worktree cleanup on task cancellation or errors
- Version alignment from 2.0.13

## [2.0.13] - 2026-11-05
### Added
- `GitWorktree` utilities (`createWorktree`, `removeWorktree`, `commitAllIfDirty`, `getBranchDiffStat`, `toBranchSafeSegment`) for creating isolated, concurrent working directories and branches per sub-agent
- Full support for safe parallel multi-agent execution: each sub-agent (`researcher`, `code_expert`, `tester`, `writer`) now operates in its own Git worktree — preventing edit conflicts even when modifying the same files simultaneously
- Comprehensive test coverage (`gitWorktree.test.ts`, updated approval tests)
- Integration into core agent loop and approval system

### Changed
- `package.json` version bumped to 2.0.13
- Updated `approvals.ts`, `extension.ts` and agent dispatch logic to leverage worktree isolation
- README version references, feature descriptions, and version badge refreshed

### Fixed
- Race conditions and file conflicts during concurrent sub-agent operations
- Minor test and approval flow edge cases

## [2.0.12] - 2026-10-29
### Added
- Final Marketplace configuration polish: complete `enumDescriptions` for all providers/approval policies, full JSON schema for `mcpServers` (including `additionalProperties`, nested `command`/`args`/`env`/`cwd` with `required` fields), explicit `deprecationMessage` on `apiKey`, `minimum`/`maximum` bounds on `inlineCompletionDebounce`, expanded `categories` (now includes "Azure")
- Rich inline documentation for `contextTokenBudget` (shared token truncation across active file + open tabs) and Azure-specific settings
- Additional commands (`setApiKey`, explain/fix/test) and keybindings fully registered in `contributes`
- Stricter build pipeline (`vscode:prepublish`, `package` script now runs `check-types` + `lint` before esbuild)

### Changed
- `package.json` version, metadata, engines, activationEvents, views, and configuration properties now 100% aligned with implementation (`extension.ts`, `aiProviderAdapter.ts`, `CodePartnerSidebarProvider`, approval flows)
- Updated devDependencies (TypeScript 5.9.3, ESLint 9 + typescript-eslint ^8, latest @types/* and test runners)
- README configuration table, feature matrix, and Quick Start refreshed to match the new schema and deprecation guidance exactly

### Fixed
- Version drift (package.json now at **2.0.12**)
- Minor schema validation issues in MCP server definitions and approval policy descriptions
- Consistency between runtime defaults, settings UI, and documentation

## [2.0.11] - 2026-10-28
### Added
- Rich `enumDescriptions` and validation for `approvalPolicy` (`always-ask` / `ask-for-shell` / `full-auto` / `yolo` with explicit prompt-injection safeguards)
- `contextTokenBudget` (shared 6000-token default across active editor + all open tabs, with line-boundary truncation via `truncateToTokenBudget`)
- Comprehensive Azure configuration (`azureApiVersion`, `azureDeployments` array)
- Prominent `codepartner.setApiKey` command with automatic migration from deprecated `apiKey` setting (using `API_KEY_SECRET_KEY` + SecretStorage)
- Full schema for `mcpServers` (command/args/env/cwd per server)
- Inline completion constraints (`inlineCompletionDebounce` with 200–3000ms bounds)
- Updated runtime (`puppeteer-core ^25.8.0`) and dev tooling (TypeScript 5.9.3, esbuild, ESLint 9)

### Changed
- `CodePartnerSidebarProvider` and `AgentManager` now respect detailed approval policies before any gated tool (`GATED_TOOLS`, `needsApprovalForPolicy`)
- Marketplace metadata, configuration table in README, and deprecation messaging fully aligned
- Build pipeline (`package` script, `vscode:prepublish`) hardened with stricter linting and type checking

### Fixed
- Version drift (package.json now at **2.0.11**)
- Edge cases in SecretStorage migration, browser Chrome path resolution, and MCP server spawning
- Output formatting for combined stdout/stderr in terminal tools (`formatOutput`)

## [2.0.10] - 2026-10-27
### Added
- Expanded `contributes.configuration` schema in `package.json` (provider enum + descriptions, full `approvalPolicy` options with `enumDescriptions`, `contextTokenBudget`, `mcpServers` object schema with command/args/env/cwd, Azure settings, inline completion options, deprecation notice for `apiKey`)
- Comprehensive configuration table and feature matrix in README.md
- `setApiKey` command registration and SecretStorage migration logic (`API_KEY_SECRET_KEY`)
- Validation helpers for approval policies and token budgets
- Updated Marketplace metadata (categories, activationEvents, icon, badges)

### Changed
- `CodePartnerSidebarProvider` and configuration resolver now surface rich descriptions and validation messages
- README Quick Start updated to prioritize `codepartner.setApiKey` over direct setting edits
- `.vscodeignore` refined to exclude `src/`, tests, and dev docs (smaller VSIX)
- Build scripts and TypeScript config aligned for stricter checks

### Fixed
- Configuration drift between `package.json`, README table, and runtime defaults
- Minor issues in MCP server schema parsing and browser path resolution
- Version references and links across documentation

## [2.0.9] - 2026-10-25
### Added
- Secure API key handling with VS Code SecretStorage (`API_KEY_SECRET_KEY`, automatic migration from settings)
- Virtual document content providers (`SingleContentProvider`, `CodePartnerDiffProvider` for side-by-side proposed changes)
- `formatOutput` utility for combining process stdout/stderr in terminal tools
- Cross-platform `BrowserManager` with `findChromePath()` for reliable Puppeteer automation on Win/macOS/Linux
- Enhanced `ArtifactRegistry` and `SkillManager` for global `~/.codepartner/{artifacts,skills}` persistence
- `AgentManager` with `dispatch()` + status tracking for parallel `researcher`/`code_expert`/`tester`/`writer` sub-agents
- `findAutoTriggeredSkills()` for proactive skill suggestions

### Changed
- `CodePartnerSidebarProvider` now fully integrates diff views, approval flows, and virtual docs
- Configuration updated with deprecation notice for `codepartner.apiKey` (use "Set API Key" command)
- Improved streaming, JSON repair, and token budgeting in core agent loop
- Marketplace assets and documentation finalized (hero image, feature grid, config table)

### Fixed
- Chrome executable detection across platforms for browser tools
- Output formatting and error recovery in MCP, Git, and shell command execution
- Version alignment between `package.json` (now 2.0.9), README, and this changelog

## [2.0.8] - 2026-10-20
### Added
- Final Marketplace readiness (icon, polished README, optimized `.vscodeignore`)
- Full integration of approval flows, secret scanning, and prompt injection protection into core agent loop
- Complete parallel sub-agent execution with `call_subagent` tool support

### Changed
- Consolidated UI tabs, global persistence, and error recovery mechanisms
- Updated all documentation and metadata for VS Code Marketplace publication

### Fixed
- Remaining stability issues across MCP, browser automation, and Git operations

## [2.0.7] - 2026-10-15
### Added
- Comprehensive approval system (`ApprovalPolicy`, `GATED_TOOLS`, `needsApprovalForPolicy`)
- Prompt injection guard (`UntrustedContentTracker`)
- Secret scanner (`scanForSecrets`, `summarizeFindings`)
- Token estimation/truncation utilities (`estimateTokens`, `truncateToTokenBudget`)
- JSON repair for robust streaming (`repairJsonParse`)

### Changed
- Enhanced agent loop with approval checks and safety gates before tool execution
- Improved context compaction logic using LLM summarization for conversations >40 messages

### Fixed
- Edge cases in multi-provider streaming and tool call extraction

## [2.0.6] - 2026-10-12
### Added
- Line-based diff engine (`diffLines`, `groupIntoHunks`, `applyAcceptedHunks`)
- Planning utilities (`buildPlanFromTasks`, `validatePlanIndex`)
- Slash commands (`/fix`, `/explain`, `/test`, `/compact`)
- Git checkpointing and restore for Timeline undo (`createGitCheckpoint`, `restoreFileFromCheckpoint`)

### Changed
- Architect Mode now uses draft system with review before apply
- Sub-agent dispatch (`AgentManager.dispatch`, `runInternalAgent`) fully enabled for parallel researcher/coder/tester/writer tasks
- Semantic search upgraded to TF-IDF implementation

### Fixed
- Better handling of open editor tabs context and shared token budgets

## [2.0.5] - 2026-10-09
### Added
- Inline completions provider with debounce config
- Full GitManager (status, stage, commit with AI co-author, branch, PR creation)
- Timeline view with per-action history and one-click undo
- Feedback system (bug reports/feature requests)

### Changed
- Major refactoring of `CodePartnerSidebarProvider` for tabbed interface (Chat/Timeline/Artifacts/Plan/Skills)
- MCPManager enhancements for custom tool servers
- BrowserManager switched to Puppeteer for reliable automation/screenshots

### Fixed
- Terminal output capture and formatting improvements

## [2.0.4] - 2026-10-07
### Added
- Multi-provider adapter (`buildProviderRequest`, support for Anthropic/Google/Ollama)
- Knowledge base tools (`index_docs`, `query_knowledge`)
- Skill suggestions and global `SkillManager`/`ArtifactRegistry`
- `getScopedTools` for sub-agent specific capabilities

### Changed
- System prompts updated for Fast/Planning/Architect modes
- Improved streaming parser and eventsource handling
- Global `~/.codepartner` persistence for cross-workspace skills/artifacts/knowledge

### Fixed
- Various stability and error recovery from v2.0.3

## [2.0.3] - 2026-10-05
### Added
- Support for additional context from all open editor tabs
- Context compaction for long-running conversations (auto-summarization)
- Enhanced error recovery with automatic retries and fallbacks

### Changed
- Improved semantic search using TF-IDF for better `@workspace` relevance
- Updated configuration options (inline completions, MCP servers, approval policy)

## [2.0.2] - 2026-10-04
### Added
- **MCP Support**: Full Model Context Protocol integration for custom tool servers
- **Architect Mode**: Draft changes without immediate application for review
- **Git Tools**: Full integration including status, stage, commit (with AI-generated messages), branch creation, and PRs
- **Timeline & Undo**: Visual history of all tool actions with one-click revert
- **Feedback System**: Built-in bug reports and feature requests (opens GitHub or email)
- **Multi-Provider Models**: Native support for Anthropic (Claude), Google (Gemini), and Ollama (local)
- **Inline Completions**: Toggleable ghost text completions with configurable debounce
- **Sub-Agent System**: Parallel researcher, code_expert, tester, and writer agents
- **Knowledge Base**: `index_docs` and `query_knowledge` for persistent documentation
- **Skill Suggestions**: Proactive detection of reusable workflows

### Changed
- Major UI overhaul with tabbed interface (Chat, Timeline, Artifacts, Plan, Skills)
- Updated system prompts with strict agentic rules for reliability
- Global `~/.codepartner` directory for skills, artifacts, and knowledge (cross-project)
- Enhanced browser control with Puppeteer for research and screenshots
- Improved streaming parser and tool execution with parallel tool calls
- Better diff/review workflow with before/after views

### Fixed
- Various stability issues and error handling from v2.0.1
- Package icon reference and marketplace metadata
- Git operations and terminal output capture

## [2.0.1] - 2026-09-20
### Added
- Initial v2.0 architecture with agent-first design
- Planning Mode with implementation plans and approval workflow
- Fast Mode for direct action
- Global Skill system with `create_skill`/`use_skill`
- Browser automation tools
- Artifact registry for persistent outputs

## [1.x] - 2026
- Initial releases with basic chat and code assistance
- Azure OpenAI support
- Basic file edit capabilities

*For full history, see Git commits or previous VSIX releases.*