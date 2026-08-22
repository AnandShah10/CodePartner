# Change Log

All notable changes to the **CodePartner AI** VS Code extension will be documented in this file.

This follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) conventions.

## [2.0.3]
### Added
- Support for additional context from open editor tabs
- Context compaction for long-running conversations
- Enhanced error recovery with automatic retries and fallbacks

### Changed
- Improved semantic search using TF-IDF for better `@workspace` relevance

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