import * as assert from "assert";
import { buildEmbeddingRequest, extractEmbeddings, cosineSimilarity, chunkText } from "../embeddings";

suite("buildEmbeddingRequest", () => {
  test("openai: default URL, auth header, default model, batch input", () => {
    const req = buildEmbeddingRequest({ providerType: "openai", apiEndpoint: "", apiKey: "sk-x", model: "", input: ["a", "b"] });
    assert.strictEqual(req.url, "https://api.openai.com/v1/embeddings");
    assert.strictEqual(req.headers["Authorization"], "Bearer sk-x");
    assert.strictEqual(req.body.model, "text-embedding-3-small");
    assert.strictEqual(req.isBatch, true);
  });

  test("azure: deployment URL, api-key header, no model field in body", () => {
    const req = buildEmbeddingRequest({
      providerType: "azure", apiEndpoint: "https://res.openai.azure.com", apiKey: "k",
      model: "my-embed-deploy", azureApiVersion: "2024-06-01", input: "hello",
    });
    assert.strictEqual(req.url, "https://res.openai.azure.com/openai/deployments/my-embed-deploy/embeddings?api-version=2024-06-01");
    assert.strictEqual(req.headers["api-key"], "k");
    assert.strictEqual("model" in req.body, false);
  });

  test("google: default URL and default model", () => {
    const req = buildEmbeddingRequest({ providerType: "google", apiEndpoint: "", apiKey: "g", model: "", input: ["x"] });
    assert.strictEqual(req.url, "https://generativelanguage.googleapis.com/v1beta/openai/embeddings");
    assert.strictEqual(req.body.model, "text-embedding-004");
  });

  test("ollama: default localhost URL, single-prompt (not batch) body, no auth header", () => {
    const req = buildEmbeddingRequest({ providerType: "ollama", apiEndpoint: "", apiKey: "", model: "", input: ["first", "second"] });
    assert.strictEqual(req.url, "http://localhost:11434/api/embeddings");
    assert.strictEqual(req.body.prompt, "first");
    assert.strictEqual(req.isBatch, false);
    assert.strictEqual("Authorization" in req.headers, false);
  });
});

suite("extractEmbeddings", () => {
  test("openai-shape: reorders results by index rather than trusting array order", () => {
    const resp = { data: [{ embedding: [0.1, 0.2], index: 1 }, { embedding: [0.9, 0.8], index: 0 }] };
    assert.deepStrictEqual(extractEmbeddings("openai", resp), [[0.9, 0.8], [0.1, 0.2]]);
  });

  test("ollama-shape: wraps the single embedding in an array", () => {
    assert.deepStrictEqual(extractEmbeddings("ollama", { embedding: [0.5, 0.6, 0.7] }), [[0.5, 0.6, 0.7]]);
  });

  test("handles a missing/malformed response gracefully instead of throwing", () => {
    assert.deepStrictEqual(extractEmbeddings("openai", {}), []);
    assert.deepStrictEqual(extractEmbeddings("ollama", {}), []);
    assert.deepStrictEqual(extractEmbeddings("openai", { data: "not an array" }), []);
  });
});

suite("cosineSimilarity", () => {
  test("identical vectors are similarity 1", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  });

  test("orthogonal vectors are similarity 0", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  });

  test("opposite vectors are similarity -1", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - -1) < 1e-9);
  });

  test("mismatched-length vectors return 0 rather than throwing", () => {
    assert.strictEqual(cosineSimilarity([1, 2, 3], [1, 2]), 0);
  });

  test("empty vectors return 0", () => {
    assert.strictEqual(cosineSimilarity([], []), 0);
  });

  test("a zero vector returns 0, not NaN", () => {
    assert.strictEqual(cosineSimilarity([0, 0], [1, 1]), 0);
  });
});

suite("chunkText", () => {
  test("short text returns a single chunk", () => {
    assert.deepStrictEqual(chunkText("short", 2000), ["short"]);
  });

  test("empty text returns no chunks", () => {
    assert.deepStrictEqual(chunkText("", 2000), []);
  });

  test("long text splits into multiple chunks, each within the size bound", () => {
    const longText = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkText(longText, 1000, 100);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 1050)); // small slack for line-boundary snap
  });
});