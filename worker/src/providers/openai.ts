// OpenAI adapter — edge transport. The Worker calls api.openai.com directly
// with the operator's OPENAI_API_KEY secret (no residential-IP constraint, so
// no tunnel hop). OpenAI already speaks the canonical OpenAI shape, so chat and
// embeddings are near-passthrough: rewrite `model` (strip the provider prefix),
// swap in the operator key, forward, and stream the response straight back.

import { passThroughResponse, openaiError } from "../http.js";
import type { Provider, ProviderChatArgs, ProviderEmbedArgs } from "./types.js";
import type { Env } from "../env.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

// Bare model families OpenAI owns, for prefixless routing. An explicit
// "openai/<model>" prefix always wins regardless of this list.
const OWNS = /^(gpt-|o[0-9]|chatgpt|text-embedding-|text-davinci|davinci-|babbage-|whisper-|tts-|dall-e)/i;

const MODEL_IDS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "o3",
  "o4-mini",
  "text-embedding-3-small",
  "text-embedding-3-large",
];

function baseUrl(env: Env): string {
  const b = env.OPENAI_BASE_URL && env.OPENAI_BASE_URL.length > 0 ? env.OPENAI_BASE_URL : DEFAULT_BASE_URL;
  return b.replace(/\/+$/, "");
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

async function chat({ openaiReq, model, stream, env }: ProviderChatArgs): Promise<Response> {
  const body = JSON.stringify({ ...openaiReq, model });
  const res = await edgeFetch(`${baseUrl(env)}/chat/completions`, env.OPENAI_API_KEY!, body, stream);
  if ("error" in res) return openaiError(502, `openai upstream unreachable: ${res.error}`, "api_error", "upstream_unavailable");
  return passThroughResponse(res as unknown as Awaited<ReturnType<typeof fetch>>);
}

async function embed({ body, model, env }: ProviderEmbedArgs): Promise<Response> {
  const payload = JSON.stringify({ ...body, model });
  const res = await edgeFetch(`${baseUrl(env)}/embeddings`, env.OPENAI_API_KEY!, payload, false);
  if ("error" in res) return openaiError(502, `openai upstream unreachable: ${res.error}`, "api_error", "upstream_unavailable");
  return passThroughResponse(res as unknown as Awaited<ReturnType<typeof fetch>>);
}

export const openaiProvider: Provider = {
  id: "openai",
  transport: "edge",
  owns: (model) => OWNS.test(model),
  configured: (env) => typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.length > 0,
  chat,
  embed,
  models: (nowSec) => MODEL_IDS.map((id) => ({ id, object: "model", created: nowSec, owned_by: "openai" })),
};
