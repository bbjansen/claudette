import type { Env } from "../env.js";
import type { OpenAIChatRequest } from "../openai-shim.js";

export type Transport = "edge" | "tunnel";

export interface ModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface ProviderChatArgs {
  // Parsed OpenAI chat request, with the provider prefix already stripped from
  // `model` (so adapters never see "openai/" etc.).
  openaiReq: OpenAIChatRequest;
  model: string;
  stream: boolean;
  env: Env;
}

export interface ProviderEmbedArgs {
  // Parsed OpenAI embeddings request body, with the provider prefix stripped.
  body: Record<string, unknown>;
  model: string;
  env: Env;
}

// A provider adapter. The gateway resolves a model → provider, checks
// `configured`, then dispatches `chat` / `embed`. Adapters return an
// OpenAI-shaped Response (or pass an already-OpenAI upstream straight through).
export interface Provider {
  readonly id: string;
  readonly transport: Transport;

  // True if this provider owns the given (prefix-stripped) bare model name.
  // Used for routing when the client sends no explicit "provider/" prefix.
  owns(model: string): boolean;

  // True when the operator has supplied whatever this provider needs to serve
  // traffic (e.g. its API-key secret). Tunnel providers that authenticate at
  // the agent return true unconditionally.
  configured(env: Env): boolean;

  // Handle an OpenAI-shaped chat completion (streaming or not). Absent if the
  // provider is embeddings-only (e.g. Voyage).
  chat?(args: ProviderChatArgs): Promise<Response>;

  // Handle an OpenAI-shaped embeddings request. Absent if the provider has no
  // embeddings API (e.g. Anthropic).
  embed?(args: ProviderEmbedArgs): Promise<Response>;

  // Static model entries for GET /v1/models aggregation.
  models(nowSec: number): ModelEntry[];
}
