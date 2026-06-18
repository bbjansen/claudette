// Anthropic adapter — Claude Max via the Cloudflare Tunnel → local agent →
// api.anthropic.com. Chat requests are translated OpenAI⇄Anthropic by the
// shim; Anthropic has no embeddings API, so `embed` is intentionally absent.

import {
  openaiToAnthropic,
  anthropicToOpenai,
  anthropicErrorToOpenai,
  anthropicSseToOpenaiSse,
  type AnthropicMessageResponse,
} from "../openai-shim.js";
import { jsonResponse } from "../http.js";
import { applyTunnelAuth, callTunnel } from "../tunnel.js";
import type { Provider, ProviderChatArgs } from "./types.js";

// Owned by the Anthropic OAuth scope the agent presents; the models.list
// endpoint is x-api-key only, so the set is curated here.
const CLAUDE_MODEL_IDS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

async function chat({ openaiReq, stream, env }: ProviderChatArgs): Promise<Response> {
  const translation = openaiToAnthropic(openaiReq);
  if (!translation.ok) {
    return jsonResponse(translation.error.status, {
      error: {
        message: translation.error.message,
        type: translation.error.type,
        code: "invalid_request",
        param: null,
      },
    });
  }
  const anthropicBody = translation.body;

  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("accept", stream ? "text/event-stream" : "application/json");
  applyTunnelAuth(headers, env);

  const upstream = await callTunnel(env, JSON.stringify(anthropicBody), headers);
  if ("error" in upstream) {
    return jsonResponse(502, { error: { type: "upstream_unavailable", message: upstream.error } });
  }

  if (!upstream.ok) {
    // Translate the Anthropic error envelope into the OpenAI shape so SDK error
    // classes (RateLimitError, AuthenticationError, …) dispatch correctly.
    let anthropicBodyJson: unknown = null;
    try { anthropicBodyJson = await upstream.json(); }
    catch { /* non-JSON upstream; fall through with null */ }
    return jsonResponse(upstream.status, anthropicErrorToOpenai(upstream.status, anthropicBodyJson));
  }

  const nowSec = Math.floor(Date.now() / 1000);

  if (stream) {
    if (!upstream.body) return jsonResponse(502, { error: { type: "upstream_unavailable", message: "no body" } });
    const translated = anthropicSseToOpenaiSse(
      upstream.body as unknown as ReadableStream<Uint8Array>,
      openaiReq.model,
      nowSec,
    );
    return new Response(
      translated as unknown as ReadableStream<Uint8Array>,
      { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
    );
  }

  let anthResp: AnthropicMessageResponse;
  try { anthResp = await upstream.json() as AnthropicMessageResponse; }
  catch (e) {
    return jsonResponse(502, anthropicErrorToOpenai(502, { error: { type: "api_error", message: `upstream returned non-JSON: ${(e as Error).message}` } }));
  }
  return jsonResponse(200, anthropicToOpenai(anthResp, nowSec));
}

export const anthropicProvider: Provider = {
  id: "anthropic",
  transport: "tunnel",
  owns: (model) => /^claude-/i.test(model),
  // Authenticated at the agent via OAuth; nothing for the operator to set on
  // the Worker. Always available.
  configured: () => true,
  chat,
  // No `embed`: Anthropic has no embeddings API. The gateway surfaces a 501.
  models: (nowSec) => CLAUDE_MODEL_IDS.map((id) => ({ id, object: "model", created: nowSec, owned_by: "anthropic" })),
};
