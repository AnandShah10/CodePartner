/**
 * Real embedding-based semantic search, as an upgrade path over the
 * existing TF-IDF search (semanticSearch.ts) when an embedding provider
 * is configured — TF-IDF remains the default and the fallback.
 *
 * HONESTY NOTE: this sandbox has no network access, so the actual HTTP
 * call to an embeddings API could not be run end-to-end here. The
 * request/response shapes below follow each provider's documented,
 * stable API contract (OpenAI's /v1/embeddings, Ollama's
 * /api/embeddings) — but that's a code review against documentation,
 * not a verified live call, unlike almost everything else built this
 * session. Everything that doesn't require an actual network round
 * trip — cosine similarity, chunking, request-shape construction,
 * response parsing given a sample payload — IS unit tested.
 *
 * Anthropic has no embeddings endpoint, so it's deliberately not one of
 * the provider options here — see extension.ts for how "same as chat
 * provider" resolves to a graceful TF-IDF fallback when the chat
 * provider is Anthropic.
 */

export type EmbeddingProviderType = "openai" | "azure" | "google" | "ollama";

export interface EmbeddingRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** True if this endpoint accepts a batch of inputs in one call. False means one call per chunk (Ollama's endpoint takes a single prompt). */
  isBatch: boolean;
}

export interface EmbeddingRequestOptions {
  providerType: EmbeddingProviderType;
  apiEndpoint: string;
  apiKey: string;
  model: string;
  azureApiVersion?: string;
  input: string | string[];
}

const DEFAULT_MODELS: Record<EmbeddingProviderType, string> = {
  openai: "text-embedding-3-small",
  azure: "text-embedding-3-small",
  google: "text-embedding-004",
  ollama: "nomic-embed-text",
};

/** The built-in default embedding model per provider, used when no explicit model is configured. */
export function defaultEmbeddingModel(providerType: EmbeddingProviderType): string {
  return DEFAULT_MODELS[providerType];
}

/** Builds the (url, headers, body) for an embeddings API call, for any supported provider. */
export function buildEmbeddingRequest(opts: EmbeddingRequestOptions): EmbeddingRequest {
  const endpoint = (opts.apiEndpoint || "").trim().replace(/\/$/, "");
  const model = opts.model || defaultEmbeddingModel(opts.providerType);
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (opts.providerType === "azure") {
    const url = `${endpoint}/openai/deployments/${model}/embeddings?api-version=${opts.azureApiVersion || "2024-02-15-preview"}`;
    headers["api-key"] = opts.apiKey;
    return { url, headers, body: { input: opts.input }, isBatch: true };
  }
  if (opts.providerType === "google") {
    const url = `${endpoint || "https://generativelanguage.googleapis.com/v1beta/openai"}/embeddings`;
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
    return { url, headers, body: { model, input: opts.input }, isBatch: true };
  }
  if (opts.providerType === "ollama") {
    const url = `${endpoint || "http://localhost:11434"}/api/embeddings`;
    // Ollama's embeddings endpoint takes ONE prompt per call, not a batch array.
    const prompt = Array.isArray(opts.input) ? opts.input[0] : opts.input;
    return { url, headers, body: { model, prompt }, isBatch: false };
  }
  // openai, or any OpenAI-compatible custom endpoint.
  const url = `${endpoint || "https://api.openai.com/v1"}/embeddings`;
  headers["Authorization"] = `Bearer ${opts.apiKey}`;
  return { url, headers, body: { model, input: opts.input }, isBatch: true };
}

/** Parses an embeddings API response into an array of vectors, in the same order as the request's input. */
export function extractEmbeddings(providerType: EmbeddingProviderType, responseData: any): number[][] {
  if (providerType === "ollama") {
    return Array.isArray(responseData?.embedding) ? [responseData.embedding] : [];
  }
  // OpenAI-shape (also used by azure and google here): { data: [{ embedding, index }, ...] }
  const items = responseData?.data;
  if (!Array.isArray(items)) return [];
  return items
    .slice()
    .sort((a: any, b: any) => (a?.index ?? 0) - (b?.index ?? 0))
    .map((item: any) => item?.embedding)
    .filter((e: any) => Array.isArray(e));
}

/** Cosine similarity between two vectors, in [-1, 1]. Returns 0 for empty or mismatched-length vectors rather than throwing. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Splits text into chunks suitable for embedding (embedding APIs have
 * input size limits), roughly `maxChars` each, breaking on a line
 * boundary where possible so a chunk doesn't cut a line in half. Chunks
 * overlap by `overlapChars` so a match spanning a chunk boundary isn't
 * missed entirely.
 */
export function chunkText(text: string, maxChars = 2000, overlapChars = 200): string[] {
  if (text.length === 0) return [];
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > start + maxChars * 0.5) {
        end = lastNewline;
      }
    }
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks;
}