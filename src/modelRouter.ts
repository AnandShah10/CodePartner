/**
 * Phase 3 — lightweight model routing.
 * Chat/agent vs inline completion can use different model ids.
 */

import * as vscode from "vscode";

export type ModelRole = "agent" | "completion" | "embedding";

/**
 * Resolve the model id for a role from settings.
 * - agent: codepartner.model
 * - completion: codepartner.completionModel or fall back to agent model
 * - embedding: codepartner.embeddingModel (caller may have separate endpoint)
 */
export function resolveModelId(role: ModelRole): string {
  const config = vscode.workspace.getConfiguration("codepartner");
  const agent = (config.get<string>("model") || "").trim();
  if (role === "agent") {
    return agent;
  }
  if (role === "completion") {
    const completion = (config.get<string>("completionModel") || "").trim();
    return completion || agent;
  }
  if (role === "embedding") {
    return (config.get<string>("embeddingModel") || "").trim() || agent;
  }
  return agent;
}
