/**
 * Provider-agnostic chat-completion request building for CodePartner's
 * supported LLM providers (OpenAI-compatible, Azure OpenAI, Anthropic,
 * Google, Ollama).
 *
 * Before this module existed, this branching (URL, headers, body shape
 * per provider) was duplicated across THREE places in extension.ts —
 * handlePrompt(), runInternalAgent(), and compactContext() — not two as
 * originally scoped, and they'd already drifted out of sync with each
 * other:
 *  - compactContext()'s Azure branch left a stray `model` field in the
 *    body (left over from the shared default), while the other two
 *    call sites correctly omit it — Azure infers the model from the
 *    deployment name in the URL.
 *  - compactContext() had no dedicated Google or Ollama branch at all;
 *    Google/Ollama requests fell through to its generic "else" branch,
 *    which used the raw (un-defaulted) endpoint and would build a
 *    broken URL for a Google-provider user who left apiEndpoint blank
 *    (relying on the default the other two call sites provide), and
 *    would send a spurious empty `Authorization: Bearer` header to a
 *    local Ollama server.
 * This module is the one implementation all three now share, so a
 * provider-specific fix only needs to happen once.
 *
 * NOT covered here: the streaming SSE parse loop in handlePrompt(). It
 * only exists at that one call site (compactContext/runInternalAgent are
 * both non-streaming), so consolidating it wouldn't reduce duplication,
 * and it's tightly coupled to handlePrompt's live tool-call-accumulation
 * state — folding it into this module was judged higher risk than the
 * value it would add in this pass.
 */

export interface ProviderMessage {
  role: string;
  content: any;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

/** Flat tool definition shape used by TOOLS/mcpManager.getTools() in extension.ts. */
export interface FlatToolDef {
  name: string;
  description: string;
  parameters: { type: string; properties?: Record<string, any>; required?: string[] };
}

export interface ProviderRequestOptions {
  /** "openai" | "azure" | "anthropic" | "google" | "ollama", or any other value treated as an OpenAI-compatible custom endpoint. */
  providerType: string;
  apiEndpoint: string;
  apiKey: string;
  modelId: string;
  azureApiVersion: string;
  messages: ProviderMessage[];
  tools?: FlatToolDef[];
  /** When false, a "system" message is sent with role "user" instead (fallback for models/providers that reject a system role). */
  useSystemRole: boolean;
  maxTokens: number;
  /** Omitted from the body entirely when undefined, matching each call site's original behavior. */
  temperature?: number;
  stream: boolean;
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function buildOpenAIMessages(messages: ProviderMessage[], useSystemRole: boolean): any[] {
  return messages.map((m) => {
    const msg: any = { role: m.role === "system" && !useSystemRole ? "user" : m.role, content: m.content };
    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) {
      msg.tool_call_id = m.tool_call_id;
      if (m.name) msg.name = m.name;
    }
    if (m.name && m.role !== "tool") msg.name = m.name;
    return msg;
  });
}

function buildAnthropicMessages(messages: ProviderMessage[]): any[] {
  const anthropicMessages: any[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "tool") {
      anthropicMessages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        }],
      });
    } else if (m.role === "assistant" && m.tool_calls) {
      const contentBlocks: any[] = [];
      if (m.content) contentBlocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        let parsedInput = {};
        try { parsedInput = JSON.parse(tc.function.arguments); } catch { parsedInput = {}; }
        contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parsedInput });
      }
      anthropicMessages.push({ role: "assistant", content: contentBlocks });
    } else {
      anthropicMessages.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      });
    }
  }
  if (anthropicMessages.length === 0) {
    // Anthropic's Messages API requires at least one non-system message.
    // A system-prompt-only call (e.g. a single-shot sub-agent task) needs
    // a synthetic turn for the model to respond to.
    anthropicMessages.push({ role: "user", content: "Begin your task." });
  }
  return anthropicMessages;
}

function toAnthropicTools(tools: FlatToolDef[]): any[] {
  return tools.map((t) => {
    const schema: any = { type: "object", properties: t.parameters.properties || {} };
    if (t.parameters.required && t.parameters.required.length > 0) {
      schema.required = t.parameters.required;
    }
    return { name: t.name, description: t.description, input_schema: schema };
  });
}

function toOpenAITools(tools: FlatToolDef[]): any[] {
  return tools.map((t) => ({ type: "function" as const, function: t }));
}

/** Builds the (url, headers, body) for a chat-completion call, for any supported provider. */
export function buildProviderRequest(opts: ProviderRequestOptions): ProviderRequest {
  const { providerType, modelId, azureApiVersion, messages, tools, useSystemRole, maxTokens, temperature, stream, apiKey } = opts;
  const endpoint = (opts.apiEndpoint || "").trim().replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (providerType === "anthropic") {
    const url = endpoint || "https://api.anthropic.com/v1/messages";
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    if (modelId.includes("claude-3-5") || modelId.includes("claude-3.5")) {
      headers["anthropic-beta"] = "max-tokens-3-5-sonnet-2024-07-15";
    }

    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: maxTokens,
      messages: buildAnthropicMessages(messages),
    };
    if (temperature !== undefined) body.temperature = temperature;
    if (stream) body.stream = true;

    const sysMsg = messages.find((m) => m.role === "system");
    if (sysMsg) body.system = sysMsg.content;
    if (tools && tools.length > 0) body.tools = toAnthropicTools(tools);

    return { url, headers, body };
  }

  // OpenAI-compatible family: openai, azure, google, ollama, or any custom
  // OpenAI-compatible endpoint.
  const openaiMessages = buildOpenAIMessages(messages, useSystemRole);
  const body: Record<string, unknown> = { messages: openaiMessages, max_tokens: maxTokens };
  if (temperature !== undefined) body.temperature = temperature;
  if (stream) body.stream = true;
  if (tools && tools.length > 0) {
    body.tools = toOpenAITools(tools);
    body.tool_choice = "auto";
  }

  if (providerType === "azure") {
    // Azure infers the model from the deployment name in the URL — no
    // `model` field in the body (see module doc comment: compactContext
    // used to leave a stray one in from a shared default body).
    const url = `${endpoint}/openai/deployments/${modelId}/chat/completions?api-version=${azureApiVersion}`;
    headers["api-key"] = apiKey;
    return { url, headers, body };
  }

  body.model = modelId;

  if (providerType === "google") {
    const url = `${endpoint || "https://generativelanguage.googleapis.com/v1beta/openai"}/chat/completions`;
    headers["Authorization"] = `Bearer ${apiKey}`;
    return { url, headers, body };
  }
  if (providerType === "ollama") {
    // No Authorization header — a local Ollama server doesn't use one,
    // and sending an empty "Bearer " is just noise.
    const url = `${endpoint || "http://localhost:11434/v1"}/chat/completions`;
    return { url, headers, body };
  }

  // OpenAI, or any other OpenAI-compatible custom endpoint.
  const url = `${endpoint || "https://api.openai.com/v1"}/chat/completions`;
  headers["Authorization"] = `Bearer ${apiKey}`;
  return { url, headers, body };
}

/** Extracts the assistant's text from a NON-streamed chat-completion response. */
export function extractNonStreamedText(providerType: string, responseData: any): string {
  if (providerType === "anthropic") {
    return responseData?.content?.[0]?.text || "";
  }
  return responseData?.choices?.[0]?.message?.content || "";
}