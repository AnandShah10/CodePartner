# CodePartner VS Code Extension

## Overview

CodePartner is a user-friendly AI co-pilot extension for Visual Studio Code. It integrates a custom AI agent powered by any LLM (Large Language Model) via an OpenAI-compatible API. This extension provides features like interactive chat assistance, inline code completions, and a custom language model provider to help you build code, find bugs, and generate solutions efficiently.

## Features

- **Custom AI Chat Participant**: Use `@codePartner` in the VS Code Chat view for conversational assistance with your configured LLM. Supports multi-turn conversations, Markdown rendering, and streaming responses.
- **Inline Code Completions**: Get AI-powered suggestions while typing code in any file.
- **Custom Language Model Provider**: Integrates with VS Code's Language Model API to make your LLM available in tools like GitHub Copilot Chat (if compatible).
- **Configurable LLM**: Easily set up any OpenAI-compatible provider (e.g., OpenAI, Grok, Ollama local) via extension settings.
- **Error Handling and Streaming**: Robust handling for API errors and incremental response streaming for better UX.

## Installation

1. **From VSIX File**:
   - Download the `.vsix` file from the releases page (or build it yourself).
   - In VS Code, go to Extensions view (Ctrl+Shift+X), click the ... menu, and select "Install from VSIX...".
   - Select the downloaded file and reload VS Code.

2. **From Source**:
   - Clone the repository: `git clone https://github.com/AnandShah10/CodePartner.git`.
   - Install dependencies: `npm install`.
   - Build: `npm run compile`.
   - Package: `vsce package` (requires `@vscode/vsce` installed globally: `npm install -g @vscode/vsce`).
   - Install the generated `.vsix` as above.

## Requirements

- VS Code version 1.86.0 or later (for Language Model and Chat APIs).
- An OpenAI-compatible LLM API (e.g., OpenAI, Grok API, local Ollama server).
- Node.js v18+ for building.

## Configuration

After installation, configure the extension in VS Code Settings (Ctrl+,):

- **codepartner.apiEndpoint**: LLM API endpoint (e.g., `https://api.openai.com/v1` for OpenAI, `http://localhost:11434/v1` for Ollama).
- **codepartner.apiKey**: Your API key (required for authenticated providers; use a dummy for local like Ollama).
- **codepartner.model**: Model name (e.g., `gpt-4o`, `grok-beta`, `llama3`).
- **codepartner.maxTokens**: Maximum output tokens for responses (default: 512).

Example for Local Ollama:
- apiEndpoint: `http://localhost:11434/v1`
- apiKey: `ollama` (or any string)
- model: `llama3`

## Usage

### Chat Assistance
1. Open the Chat view (View > Chat or Ctrl+Shift+P > "Chat: Open Chat").
2. Type `@codePartner <your question>` (e.g., `@codePartner Explain this code snippet`).
3. The agent will respond using your configured LLM, maintaining conversation history.

### Inline Completions
- Start typing in any code file.
- Suggestions from your LLM will appear (e.g., function completions).
- Press Tab to accept.

### Custom Model in Other Tools
- If using GitHub Copilot or similar, select "CodePartner" from the model picker in compatible chats.

## Development and Debugging

1. Open the project in VS Code.
2. Run `npm install` if not done.
3. Press F5 to launch in debug mode.
4. Test features in the Extension Development Host window.

For contributions:
- Fork the repo.
- Make changes in `src/extension.ts`.
- Submit a pull request.

## Known Issues

- Streaming may not work if your LLM doesn't support it; responses will load fully instead.
- Inline completions use a basic prompt; customize in code for better results.
- Token counting is approximate; integrate a proper tokenizer (e.g., `gpt-tokenizer`) for accuracy.

## License

MIT License. See [LICENSE](https://github.com/AnandShah10/CodePartner/LICENSE) for details.

## Acknowledgments

Built with VS Code Extension APIs, Axios for HTTP, and Markdown-it for rendering. Inspired by custom AI integrations in VS Code.