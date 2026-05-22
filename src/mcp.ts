import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

/**
 * Model Context Protocol (MCP) client for CodePartner.
 * Connects to MCP servers to discover and use external tools.
 */

interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
  serverName: string;
}

interface MCPServer {
  name: string;
  config: MCPServerConfig;
  process?: cp.ChildProcess;
  tools: MCPTool[];
  ready: boolean;
  requestId: number;
  pendingRequests: Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }>;
  buffer: string;
}

export class MCPManager {
  private servers: Map<string, MCPServer> = new Map();
  private output: vscode.OutputChannel;
  private allTools: MCPTool[] = [];

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  /**
   * Load MCP server configurations from workspace and global config.
   */
  public async loadConfigs(): Promise<void> {
    const configs: Record<string, MCPServerConfig> = {};

    // Check workspace config
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      const wsConfig = path.join(root, ".codepartner", "mcp.json");
      if (fs.existsSync(wsConfig)) {
        try {
          const data = JSON.parse(fs.readFileSync(wsConfig, "utf8"));
          Object.assign(configs, data.servers || data);
          this.output.appendLine(`[MCP] Loaded workspace config: ${Object.keys(data.servers || data).length} servers`);
        } catch (e: any) {
          this.output.appendLine(`[MCP] Error reading workspace mcp.json: ${e.message}`);
        }
      }
    }

    // Check global config
    const globalConfig = path.join(os.homedir(), ".codepartner", "mcp.json");
    if (fs.existsSync(globalConfig)) {
      try {
        const data = JSON.parse(fs.readFileSync(globalConfig, "utf8"));
        Object.assign(configs, data.servers || data);
        this.output.appendLine(`[MCP] Loaded global config: ${Object.keys(data.servers || data).length} servers`);
      } catch (e: any) {
        this.output.appendLine(`[MCP] Error reading global mcp.json: ${e.message}`);
      }
    }

    // Check VS Code settings
    const settingServers = vscode.workspace.getConfiguration("codepartner").get<Record<string, MCPServerConfig>>("mcpServers", {});
    Object.assign(configs, settingServers);

    // Start servers
    for (const [name, config] of Object.entries(configs)) {
      await this.startServer(name, config);
    }
  }

  /**
   * Start an MCP server process.
   */
  private async startServer(name: string, config: MCPServerConfig): Promise<void> {
    if (this.servers.has(name)) {
      this.output.appendLine(`[MCP] Server '${name}' already running, restarting...`);
      this.stopServer(name);
    }

    const server: MCPServer = {
      name,
      config,
      tools: [],
      ready: false,
      requestId: 0,
      pendingRequests: new Map(),
      buffer: "",
    };

    try {
      const env = { ...process.env, ...config.env };
      const proc = cp.spawn(config.command, config.args || [], {
        cwd: config.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      server.process = proc;

      proc.stdout?.on("data", (data: Buffer) => {
        server.buffer += data.toString("utf8");
        this.processBuffer(server);
      });

      proc.stderr?.on("data", (data: Buffer) => {
        this.output.appendLine(`[MCP:${name}] stderr: ${data.toString().trim()}`);
      });

      proc.on("exit", (code) => {
        this.output.appendLine(`[MCP:${name}] Process exited with code ${code}`);
        server.ready = false;
      });

      proc.on("error", (err) => {
        this.output.appendLine(`[MCP:${name}] Process error: ${err.message}`);
        server.ready = false;
      });

      this.servers.set(name, server);

      // Initialize the server
      await this.sendRequest(server, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "CodePartner", version: "2.0.0" },
      });

      // Send initialized notification
      this.sendNotification(server, "notifications/initialized", {});

      // Discover tools
      const toolsResult = await this.sendRequest(server, "tools/list", {});
      if (toolsResult?.tools) {
        server.tools = toolsResult.tools.map((t: any) => ({
          name: `mcp_${name}_${t.name}`,
          description: `[MCP:${name}] ${t.description || t.name}`,
          inputSchema: t.inputSchema,
          serverName: name,
        }));
        this.output.appendLine(`[MCP:${name}] Discovered ${server.tools.length} tools`);
      }

      server.ready = true;
      this.rebuildToolList();
    } catch (e: any) {
      this.output.appendLine(`[MCP:${name}] Failed to start: ${e.message}`);
    }
  }

  /**
   * Process the JSON-RPC buffer for incoming responses.
   */
  private processBuffer(server: MCPServer): void {
    const lines = server.buffer.split("\n");
    server.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }

      try {
        const msg = JSON.parse(trimmed);

        if (msg.id !== undefined && server.pendingRequests.has(msg.id)) {
          const pending = server.pendingRequests.get(msg.id)!;
          server.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Not valid JSON, skip
      }
    }
  }

  /**
   * Send a JSON-RPC request to an MCP server.
   */
  private sendRequest(server: MCPServer, method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++server.requestId;
      const request = { jsonrpc: "2.0", id, method, params };

      server.pendingRequests.set(id, { resolve, reject });

      if (!server.process?.stdin?.writable) {
        reject(new Error("Server process stdin not writable"));
        return;
      }

      server.process.stdin.write(JSON.stringify(request) + "\n");

      // Timeout after 30 seconds
      setTimeout(() => {
        if (server.pendingRequests.has(id)) {
          server.pendingRequests.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }
      }, 30_000);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  private sendNotification(server: MCPServer, method: string, params: any): void {
    const notification = { jsonrpc: "2.0", method, params };
    server.process?.stdin?.write(JSON.stringify(notification) + "\n");
  }

  /**
   * Call a tool on an MCP server.
   */
  public async callTool(toolName: string, args: any): Promise<string> {
    // Parse tool name: mcp_<serverName>_<actualToolName>
    const parts = toolName.replace(/^mcp_/, "").split("_");
    const serverName = parts[0];
    const actualToolName = parts.slice(1).join("_");

    const server = this.servers.get(serverName);
    if (!server || !server.ready) {
      return `Error: MCP server '${serverName}' not available.`;
    }

    try {
      const result = await this.sendRequest(server, "tools/call", {
        name: actualToolName,
        arguments: args,
      });

      // Extract text content from MCP response
      if (result?.content) {
        return result.content
          .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
          .join("\n");
      }

      return JSON.stringify(result);
    } catch (e: any) {
      return `Error calling MCP tool: ${e.message}`;
    }
  }

  /**
   * Get all discovered MCP tools in the format expected by the TOOLS array.
   */
  public getTools(): any[] {
    return this.allTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema || { type: "object", properties: {} },
    }));
  }

  /**
   * Check if a tool name belongs to an MCP server.
   */
  public isMCPTool(name: string): boolean {
    return name.startsWith("mcp_");
  }

  private rebuildToolList(): void {
    this.allTools = [];
    for (const server of this.servers.values()) {
      this.allTools.push(...server.tools);
    }
  }

  /**
   * Stop a specific server.
   */
  public stopServer(name: string): void {
    const server = this.servers.get(name);
    if (server?.process) {
      server.process.kill();
      server.ready = false;
    }
    this.servers.delete(name);
    this.rebuildToolList();
  }

  /**
   * Stop all MCP servers.
   */
  public dispose(): void {
    for (const name of this.servers.keys()) {
      this.stopServer(name);
    }
  }
}
