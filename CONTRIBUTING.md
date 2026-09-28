# Contributing to CodePartner AI

Thank you for considering contributing to CodePartner AI!

## How to Contribute

1. **Fork the repository** on GitHub
2. **Create a feature branch** (`git checkout -b feature/amazing-feature`)
3. **Make your changes** following the code style
4. **Test thoroughly** (the extension has comprehensive tool testing via the agent itself)
5. **Commit with conventional messages** (use the built-in `generate_commit_message` tool!)
6. **Open a Pull Request**

## Development Setup

```bash
# Install dependencies
npm install

# Compile and watch
npm run watch

# Press F5 in VS Code to launch extension development host
```

## Architecture

- `src/extension.ts`: Core agent logic, tools, webview provider
- `src/git.ts`: Git operations
- `src/inlineCompletion.ts`: Ghost text provider
- `src/mcp.ts`: MCP server integration
- `src/semanticSearch.ts`: TF-IDF based workspace search
- `media/`: Webview UI (HTML/JS/CSS injected)

See the [system prompts](src/extension.ts) for the agent's behavior rules.

## Adding New Tools

1. Add to the `TOOLS` array in `extension.ts`
2. Implement `executeTool` case
3. Update README and CHANGELOG
4. Test with the agent itself using `call_subagent` or direct prompts

## Reporting Bugs / Feature Requests

Use the **Feedback** button in the extension sidebar or open an issue on GitHub.

---

Happy hacking! The agent can even help you implement your contributions. Just ask it to "add a new tool for X".
