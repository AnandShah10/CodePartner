# Change Log

All notable changes to the **CodePartner AI** VS Code extension will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [2.1.6] - 2024-11-10
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

## [2.1.5] - 2024-11-09
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

## [2.1.4] - 2024-11-08
### Changed
- Version alignment across `package.json` (now **2.1.4**), README badge, CHANGELOG, and comparison analysis
- Documentation and feature notes refreshed to reflect stable v2.1.3 embeddings implementation now shipping in 2.1.4
- Updated "Smart Context" and configuration sections in README with clearer embeddings guidance

### Fixed
- 93 ESLint `curly` warnings (added consistent braces to all `if`/`for` statements in `embeddings.ts`, `semanticSearch.ts`, `extension.ts`, and supporting modules)
- Test runner flakiness (network timeout on `@vscode/test-electron` download during CI-like runs; pretest now succeeds cleanly)
- Minor version drift and doc inconsistencies from the embeddings rollout

## [2.1.3] - 2024-11-07
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

## [2.1.2] - 2024-11-06
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

## [2.1.1] - 2024-11-05
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

## [2.0.13] - 2024-11-05
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

## [2.0.12] - 2024-10-29
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

## [2.0.11] - 2024-10-28
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

## [2.0.10] - 2024-10-27
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

## [2.0.9] - 2024-10-25
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

## [2.0.8] - 2024-10-20
### Added
- Final Marketplace readiness (icon, polished README, optimized `.vscodeignore`)
- Full integration of approval flows, secret scanning, and prompt injection protection into core agent loop
- Complete parallel sub-agent execution with `call_subagent` tool support

### Changed
- Consolidated UI tabs, global persistence, and error recovery mechanisms
- Updated all documentation and metadata for VS Code Marketplace publication

### Fixed
- Remaining stability issues across MCP, browser automation, and Git operations

## [2.0.7] - 2024-10-15
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

## [2.0.6] - 2024-10-12
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

## [2.0.5] - 2024-10-09
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

## [2.0.4] - 2024-10-07
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

## [2.0.3] - 2024-10-05
### Added
- Support for additional context from all open editor tabs
- Context compaction for long-running conversations (auto-summarization)
- Enhanced error recovery with automatic retries and fallbacks

### Changed
- Improved semantic search using TF-IDF for better `@workspace` relevance
- Updated configuration options (inline completions, MCP servers, approval policy)

## [2.0.2] - 2024-10-04
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

## [2.0.1] - 2024-09-20
### Added
- Initial v2.0 architecture with agent-first design
- Planning Mode with implementation plans and approval workflow
- Fast Mode for direct action
- Global Skill system with `create_skill`/`use_skill`
- Browser automation tools
- Artifact registry for persistent outputs

## [1.x] - 2023-2024
- Initial releases with basic chat and code assistance
- Azure OpenAI support
- Basic file edit capabilities

*For full history, see Git commits or previous VSIX releases.*