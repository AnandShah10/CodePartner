# CodePartner — Agentic AI Coding Companion

CodePartner is a premium, agentic AI co-pilot designed to transform your development workflow. Unlike basic chat extensions, CodePartner uses a sophisticated multi-agent orchestration system to plan, execute, and iterate on complex coding tasks directly within your workspace.

Powered by any OpenAI-compatible API (including local models like Ollama), CodePartner provides a high-level interface for task planning, terminal execution, and browser-based research, making it the ultimate tool for modern software engineering.

## 🚀 Key Features

*⚡ Agentic Task Planning**: Automatically breaks down complex requests into a structured "Project Roadmap" with step-by-step progress tracking.
*📂 Multi-Agent Orchestration**: Dispatches specialized sub-agents (Researchers, CodeExperts, Testers) to handle concurrent or deep-dive sub-tasks.
*🌐 Browser Control**: An integrated browser manager for real-world research, documentation lookups, and automated screenshots.
*🛠️ Tool-Ready Core**: Built-in tools for shell command execution, directory listing, and intelligent file editing with diff verification.
*📦 Persistent Artifacts**: Save code snippets, documentation, and screenshots into a dedicated `.codepartner/artifacts` folder for long-term reference.
*🎨 Premium UI/UX**: A sleek, VS Code-native sidebar with glassmorphism aesthetics, dynamic animations, and integrated chat history.

## 📦 Installation

1. **Marketplace**: Search for `CodePartner` in the VS Code Extensions view (`Ctrl+Shift+X`) and click **Install**.
2. **Manual (VSIX)**:
   - Download the latest `.vsix` from [Releases](https://github.com/AnandShah10/CodePartner/releases).
   - Use the "Extensions: Install from VSIX..." command in VS Code.
3. From Source:

   ```bash
   git clone https://github.com/AnandShah10/CodePartner.git
   cd CodePartner
   npm install
   npm run package
   ```

## ⚙️ Configuration

Configure CodePartner in your VS Code Settings (`Ctrl+,`):

| Setting | Description | Default |
| :--- | :--- | :--- |
| `codepartner.provider` | API provider (`openai` or `azure`) | `openai` |
| `codepartner.apiEndpoint` | Your LLM endpoint URL | `https://api.openai.com/v1` |
| `codepartner.apiKey` | Your API authentication key | `(Empty)` |
| `codepartner.model` | Model/Deployment ID (e.g., `gpt-4-turbo`) | `gpt-4` |
| `codepartner.maxTokens` | Maximum response length | `1024` |
| `codepartner.azureDeployments` | List of Azure OpenAI deployment names | `["gpt-4o-mini", "gpt-4o"]` |

## 🕹️ Usage

1. Open the **CodePartner** icon in the Activity Bar.
2. (Optional) Select your preferred model from the dropdown header.
3. Start a conversation. For complex tasks, CodePartner will automatically generate a **Plan** in the Roadmap tab.
4. Monitor sub-agent activity and tool executions in the **Status Bar**.
5. View generated assets in the **Artifacts** tab or the `.codepartner/artifacts` directory.

## 🛠️ Development

To contribute or debug:

1. Clone the repository.
2. Run `npm install`.
3. Press `F5` to open the Extension Development Host.
4. Use the "CodePartner" output channel to view internal logs.

## 📄 License

This project is licensed under the [MIT License](https://github.com/AnandShah10/CodePartner/blob/master/LICENSE).

## 🤝 Acknowledgments

CodePartner is built on top of VS Code's extension architecture, utilizing `puppeteer-core` for browser automation and `markdown-it` for high-fidelity rendering. Special thanks to the open-source community for the underlying tools and inspirations.

---
Developed by **AnandShah** — [GitHub](https://github.com/AnandShah10)
