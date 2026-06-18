// Ollama provider — tunnel transport. Ollama runs on the operator's machine
// (http://localhost:11434), reachable only from the local agent, so the Worker
// forwards OpenAI-shaped chat/embeddings requests over the CF Tunnel to the
// agent's /v1/ollama/* routes, which proxy to the local Ollama server.
//
// Local model names have no stable prefix (llama3.2, nomic-embed-text, even
// gpt-oss:20b), so owns() is always false: Ollama is addressed only via the
// explicit "ollama/<model>" prefix. This also prevents a bare "gpt-oss" from
// mis-routing to OpenAI.

import { passThroughResponse, openaiError } from "../http.js";
import { applyTunnelAuth } from "../tunnel.js";
import type { Provider, ProviderChatArgs, ProviderEmbedArgs } from "./types.js";
import type { Env } from "../env.js";

async function tunnelFetch(env: Env, path: string, body: string, stream: boolean): Promise<Response | { error: string }> {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("accept", stream ? "text/event-stream" : "application/json");
  applyTunnelAuth(headers, env);
  try {
    return await fetch(`https://${env.TUNNEL_HOSTNAME}${path}`, { method: "POST", headers, body }) as unknown as Response;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export const ollamaProvider: Provider = {
  id: "ollama",
  transport: "tunnel",
  // Local model names have no stable prefix — require an explicit "ollama/" prefix.
  owns: () => false,
  // No key on the Worker; reachability depends on the operator running Ollama
  // behind the tunnel. Selected only via explicit prefix, so treat as available.
  configured: () => true,
  // Local models are operator-specific and dynamic; not enumerated in /v1/models.
  models: () => [],

  async chat({ openaiReq, model, stream, env }: ProviderChatArgs): Promise<Response> {
    const res = await tunnelFetch(env, "/v1/ollama/chat/completions", JSON.stringify({ ...openaiReq, model }), stream);
    if ("error" in res) return openaiError(502, `ollama (via tunnel) unreachable: ${res.error}`, "api_error", "upstream_unavailable");
    return passThroughResponse(res as unknown as Awaited<ReturnType<typeof fetch>>);
  },

  async embed({ body, model, env }: ProviderEmbedArgs): Promise<Response> {
    const res = await tunnelFetch(env, "/v1/ollama/embeddings", JSON.stringify({ ...body, model }), false);
    if ("error" in res) return openaiError(502, `ollama (via tunnel) unreachable: ${res.error}`, "api_error", "upstream_unavailable");
    return passThroughResponse(res as unknown as Awaited<ReturnType<typeof fetch>>);
  },
};
