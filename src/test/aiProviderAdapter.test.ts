import * as assert from "assert";
import { buildProviderRequest, extractNonStreamedText } from "../aiProviderAdapter";

const toolCallMessages = [
  { role: "system", content: "You are CodePartner." },
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi there", tool_calls: [{ id: "t1", function: { name: "run_command", arguments: '{"command":"ls"}' } }] },
  { role: "tool", content: "file1.txt", tool_call_id: "t1", name: "run_command" },
];
const tools = [{ name: "run_command", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }];

suite("buildProviderRequest — handlePrompt-style (streaming, with tools)", () => {
  test("openai: url, auth header, model, stream, temperature, tools", () => {
    const req = buildProviderRequest({
      providerType: "openai", apiEndpoint: "", apiKey: "sk-test", modelId: "gpt-4o",
      azureApiVersion: "2024-02-15-preview", messages: toolCallMessages, tools, useSystemRole: true,
      maxTokens: 4096, temperature: 0.4, stream: true,
    });
    assert.strictEqual(req.url, "https://api.openai.com/v1/chat/completions");
    assert.strictEqual(req.headers["Authorization"], "Bearer sk-test");
    assert.strictEqual(req.body.model, "gpt-4o");
    assert.strictEqual(req.body.stream, true);
    assert.strictEqual(req.body.temperature, 0.4);
    assert.strictEqual(req.body.tool_choice, "auto");
  });

  test("anthropic: system extraction, tool_use/tool_result conversion, beta header", () => {
    const req = buildProviderRequest({
      providerType: "anthropic", apiEndpoint: "", apiKey: "ant-key", modelId: "claude-3-5-sonnet-20241022",
      azureApiVersion: "", messages: toolCallMessages, tools, useSystemRole: true,
      maxTokens: 8192, temperature: 0.4, stream: true,
    });
    assert.strictEqual(req.url, "https://api.anthropic.com/v1/messages");
    assert.strictEqual(req.headers["anthropic-beta"], "max-tokens-3-5-sonnet-2024-07-15");
    assert.strictEqual(req.body.system, "You are CodePartner.");
    const msgs = req.body.messages as any[];
    assert.ok(!msgs.some((m) => m.role === "system"));
    assert.deepStrictEqual(msgs[1].content[1], { type: "tool_use", id: "t1", name: "run_command", input: { command: "ls" } });
    assert.deepStrictEqual(msgs[2].content[0], { type: "tool_result", tool_use_id: "t1", content: "file1.txt" });
  });

  test("azure: deployment URL, api-key header, no model field in body", () => {
    const req = buildProviderRequest({
      providerType: "azure", apiEndpoint: "https://myresource.openai.azure.com/", apiKey: "az-key", modelId: "my-deployment",
      azureApiVersion: "2024-06-01", messages: toolCallMessages, tools, useSystemRole: true,
      maxTokens: 4096, temperature: 0.4, stream: true,
    });
    assert.strictEqual(req.url, "https://myresource.openai.azure.com/openai/deployments/my-deployment/chat/completions?api-version=2024-06-01");
    assert.strictEqual(req.headers["api-key"], "az-key");
    assert.strictEqual(req.headers["Authorization"], undefined);
    assert.strictEqual("model" in req.body, false);
  });

  test("ollama: localhost default, no Authorization header", () => {
    const req = buildProviderRequest({
      providerType: "ollama", apiEndpoint: "", apiKey: "", modelId: "llama3",
      azureApiVersion: "", messages: toolCallMessages, tools, useSystemRole: true,
      maxTokens: 4096, temperature: 0.4, stream: true,
    });
    assert.strictEqual(req.url, "http://localhost:11434/v1/chat/completions");
    assert.strictEqual("Authorization" in req.headers, false);
  });
});

suite("buildProviderRequest — compactContext-style (non-streaming, single user message)", () => {
  const compactMessages = [{ role: "user", content: "Please summarize..." }];

  test("openai: no stream key, temperature/max_tokens preserved", () => {
    const req = buildProviderRequest({
      providerType: "openai", apiEndpoint: "", apiKey: "sk-test", modelId: "gpt-4o",
      azureApiVersion: "", messages: compactMessages, useSystemRole: true,
      maxTokens: 1000, temperature: 0.3, stream: false,
    });
    assert.strictEqual("stream" in req.body, false);
    assert.strictEqual(req.body.temperature, 0.3);
    assert.strictEqual(req.body.max_tokens, 1000);
  });

  test("anthropic: no synthetic 'Begin' turn needed when a real user message exists", () => {
    const req = buildProviderRequest({
      providerType: "anthropic", apiEndpoint: "", apiKey: "ant", modelId: "claude-3-5-sonnet-20241022",
      azureApiVersion: "", messages: compactMessages, useSystemRole: true,
      maxTokens: 1000, temperature: 0.3, stream: false,
    });
    const msgs = req.body.messages as any[];
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].content, "Please summarize...");
    assert.strictEqual("system" in req.body, false);
  });

  test("azure: no stray model field (bug present in the old duplicated code, fixed here)", () => {
    const req = buildProviderRequest({
      providerType: "azure", apiEndpoint: "https://res.openai.azure.com", apiKey: "az", modelId: "my-deploy",
      azureApiVersion: "2024-02-15-preview", messages: compactMessages, useSystemRole: true,
      maxTokens: 1000, temperature: 0.3, stream: false,
    });
    assert.strictEqual("model" in req.body, false);
  });

  test("google: gets its correct default URL instead of falling through to a broken generic branch", () => {
    const req = buildProviderRequest({
      providerType: "google", apiEndpoint: "", apiKey: "g", modelId: "gemini-2.5-pro",
      azureApiVersion: "", messages: compactMessages, useSystemRole: true,
      maxTokens: 1000, temperature: 0.3, stream: false,
    });
    assert.strictEqual(req.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  });

  test("ollama: gets its correct default URL and no spurious auth header", () => {
    const req = buildProviderRequest({
      providerType: "ollama", apiEndpoint: "", apiKey: "", modelId: "llama3",
      azureApiVersion: "", messages: compactMessages, useSystemRole: true,
      maxTokens: 1000, temperature: 0.3, stream: false,
    });
    assert.strictEqual(req.url, "http://localhost:11434/v1/chat/completions");
    assert.strictEqual("Authorization" in req.headers, false);
  });
});

suite("buildProviderRequest — runInternalAgent-style (system-prompt-only, no history)", () => {
  const subPrompt = "You are a specialized SubAgent: reviewer.\nYour task is: review this diff";
  const agentMessages = [{ role: "system", content: subPrompt }];

  test("openai-family: single system message preserved as-is, no temperature key", () => {
    const req = buildProviderRequest({
      providerType: "openai", apiEndpoint: "", apiKey: "sk", modelId: "gpt-4o",
      azureApiVersion: "", messages: agentMessages, useSystemRole: true,
      maxTokens: 2048, stream: false,
    });
    const msgs = req.body.messages as any[];
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].role, "system");
    assert.strictEqual(msgs[0].content, subPrompt);
    assert.strictEqual("temperature" in req.body, false);
  });

  test("anthropic: system extracted, synthetic 'Begin your task.' turn injected since there'd otherwise be zero messages", () => {
    const req = buildProviderRequest({
      providerType: "anthropic", apiEndpoint: "", apiKey: "ant", modelId: "claude-3-5-sonnet-20241022",
      azureApiVersion: "", messages: agentMessages, useSystemRole: true,
      maxTokens: 2048, stream: false,
    });
    assert.strictEqual(req.body.system, subPrompt);
    const msgs = req.body.messages as any[];
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].role, "user");
    assert.strictEqual(msgs[0].content, "Begin your task.");
  });
});

suite("extractNonStreamedText", () => {
  test("anthropic shape", () => {
    assert.strictEqual(extractNonStreamedText("anthropic", { content: [{ text: "hello summary" }] }), "hello summary");
  });
  test("openai-family shape", () => {
    assert.strictEqual(extractNonStreamedText("openai", { choices: [{ message: { content: "hello summary" } }] }), "hello summary");
  });
  test("falls back to empty string on an unexpected shape", () => {
    assert.strictEqual(extractNonStreamedText("openai", {}), "");
  });
});