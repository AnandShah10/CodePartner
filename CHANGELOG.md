# Change Log

All notable changes to the **CodePartner AI** VS Code extension will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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