// Factory for OpenAI-compatible edge providers.
//
// OpenAI, Google Gemini (via its /v1beta/openai/ endpoint), Voyage, and any
// other "speaks the OpenAI wire format" service differ only by base URL, key,
// owned model families, and which capabilities (chat / embeddings) they expose.
// They are all called straight from the edge with the operator's key — no
// residential-IP constraint applies to paid API keys, so no tunnel hop.

import { passThroughResponse, openaiError } from "../http.js";
import type { Provider, ProviderChatArgs, ProviderEmbedArgs } from "./types.js";
import type { Env } from "../env.js";

export interface OpenAICompatConfig {
  id: string;
  defaultBaseUrl: string;
  // Env field holding this provider's API key (e.g. "OPENAI_API_KEY").
  apiKeyEnv: keyof Env;
  // Optional Env field overriding the base URL (e.g. "OPENAI_BASE_URL").
  baseUrlEnv?: keyof Env;
  // Bare model families this provider owns, for prefixless routing.
  owns: RegExp;
  // Static model ids for /v1/models.
  modelIds: string[];
  capabilities: { chat: boolean; embed: boolean };
}

function resolveBaseUrl(cfg: OpenAICompatConfig, env: Env): string {
  const override = cfg.baseUrlEnv ? (env[cfg.baseUrlEnv] as string | undefined) : undefined;
  const base = override && override.length > 0 ? override : cfg.defaultBaseUrl;
  return base.replace(/\/+$/, "");
}

function resolveKey(cfg: OpenAICompatConfig, env: Env): string | undefined {
  return env[cfg.apiKeyEnv] as string | undefined;
}

async function edgeFetch(url: string, key: string, body: string, stream: boolean): Promise<Response | { error: string }> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
      },
      body,
    }) as unknown as Response;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function makeOpenAICompatibleProvider(cfg: OpenAICompatConfig): Provider {
  const provider: Provider = {
    id: cfg.id,
    transport: "edge",
    owns: (model) => cfg.owns.test(model),
    configured: (env) => {
      const k = resolveKey(cfg, env);
      return typeof k === "string" && k.length > 0;
    },
    models: (nowSec) => cfg.modelIds.map((id) => ({ id, object: "model", created: nowSec, owned_by: cfg.id })),
  };

  if (cfg.capabilities.chat) {
    provider.chat = async ({ openaiReq, model, stream, env }: ProviderChatArgs): Promise<Response> => {
      const res = await edgeFetch(`${resolveBaseUrl(cfg, env)}/chat/completions`, resolveKey(cfg, env)!, JSON.stringify({ ...openaiReq, model }), stream);
      if ("error" in res) return openaiError(502, `${cfg.id} upstream unreachable: ${res.error}`, "api_error", "upstream_unavailable");
      return passThroughResponse(res as unknown as Awaited<ReturnType<typeof fetch>>);
    };
  }

  if (cfg.capabilities.embed) {
    provider.embed = async ({ body, model, env }: ProviderEmbedArgs): Promise<Response> => {
      const res = await edgeFetch(`${resolveBaseUrl(cfg, env)}/embeddings`, resolveKey(cfg, env)!, JSON.stringify({ ...body, model }), false);
      if ("error" in res) return openaiError(502, `${cfg.id} upstream unreachable: ${res.error}`, "api_error", "upstream_unavailable");
      return passThroughResponse(res as unknown as Awaited<ReturnType<typeof fetch>>);
    };
  }

  return provider;
}
