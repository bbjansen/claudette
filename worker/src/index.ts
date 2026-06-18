import * as jose from "jose";
import type { Env } from "./env.js";
import { jsonResponse, passThroughResponse } from "./http.js";
import { buildTunnelHeaders, callTunnel } from "./tunnel.js";
import { resolveModel, allProviders } from "./providers/registry.js";
import type { Provider } from "./providers/types.js";
import type { OpenAIChatRequest } from "./openai-shim.js";

export type { Env };

const jwksCache = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function getJwks(teamDomain: string) {
  let getKey = jwksCache.get(teamDomain);
  if (!getKey) {
    getKey = jose.createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, getKey);
  }
  return getKey;
}

async function verifyAccessJwt(jwt: string, env: Env): Promise<void> {
  await jose.jwtVerify(jwt, getJwks(env.ACCESS_TEAM_DOMAIN), {
    audience: env.ACCESS_AUD,
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// Per RFC 7235 §2.1 auth schemes are case-insensitive. Accept any casing of
// `Bearer` and tolerate extra inter-token whitespace.
function extractBearerCredential(headerValue: string | null): string | null {
  if (headerValue == null) return null;
  const m = /^\s*bearer\s+(\S.*?)\s*$/i.exec(headerValue);
  return m ? m[1]! : null;
}

async function authorize(req: Request, env: Env, skip: boolean): Promise<Response | null> {
  if (skip) return null;
  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (jwt) {
    try { await verifyAccessJwt(jwt, env); return null; }
    catch (e) { return jsonResponse(403, { error: { type: "forbidden", message: `jwt invalid: ${(e as Error).message}` } }); }
  }
  // Accept the proxy key via either Authorization: Bearer <key> (OpenAI-style
  // clients) or x-api-key: <key> (Anthropic-native clients). Both compare
  // against PROXY_KEY in constant time.
  const expected = env.PROXY_KEY ?? null;
  const fromBearer = extractBearerCredential(req.headers.get("authorization"));
  const fromXApiKey = req.headers.get("x-api-key");
  const presented = fromBearer ?? fromXApiKey;
  const ok = expected !== null && presented !== null && timingSafeEqual(presented, expected);
  if (!ok) return jsonResponse(403, { error: { type: "forbidden", message: "missing access jwt, proxy bearer, or x-api-key" } });
  return null;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function providerNotConfigured(provider: Provider): Response {
  return jsonResponse(503, {
    error: {
      type: "provider_not_configured",
      code: "provider_not_configured",
      param: null,
      message: `Provider '${provider.id}' is selected by routing but not configured on this proxy. ` +
        `Set ${provider.id.toUpperCase()}_API_KEY as a Worker secret (\`wrangler secret put ${provider.id.toUpperCase()}_API_KEY\`).`,
    },
  });
}

// POST /v1/messages — Anthropic-native passthrough to the tunnel (Claude Max).
// Forwarded verbatim; the agent pins anthropic-version/beta and OAuth bearer.
async function handleAnthropicMessages(req: Request, env: Env): Promise<Response> {
  const headers = buildTunnelHeaders(req, env);
  const upstream = await callTunnel(env, req.body, headers);
  if ("error" in upstream) return jsonResponse(502, { error: { type: "upstream_unavailable", message: upstream.error } });
  return passThroughResponse(upstream);
}

// POST /v1/chat/completions — universal endpoint. Resolve model → provider,
// then dispatch to that provider's adapter (Anthropic via tunnel, OpenAI via
// edge, …).
async function handleChatCompletions(req: Request, env: Env): Promise<Response> {
  let openaiReq: OpenAIChatRequest;
  try { openaiReq = await req.json() as OpenAIChatRequest; }
  catch { return jsonResponse(400, { error: { type: "invalid_request_error", message: "body is not valid JSON" } }); }

  const rawModel = typeof openaiReq.model === "string" ? openaiReq.model : "";
  const { provider, model } = resolveModel(rawModel);
  if (!provider.chat) {
    return jsonResponse(501, {
      error: {
        type: "not_implemented",
        message: `${capitalize(provider.id)} is an embeddings-only provider and does not support chat completions. ` +
          `Use /v1/embeddings with one of its models instead.`,
      },
    });
  }
  if (!provider.configured(env)) return providerNotConfigured(provider);

  const stream = openaiReq.stream === true;
  return provider.chat({ openaiReq: { ...openaiReq, model }, model, stream, env });
}

// POST /v1/embeddings — resolve model → provider; dispatch if the provider has
// an embeddings API, else 501 with a clear hint (Anthropic has none).
async function handleEmbeddings(req: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; }
  catch { return jsonResponse(400, { error: { type: "invalid_request_error", message: "body is not valid JSON" } }); }

  const rawModel = typeof body.model === "string" ? body.model : "";
  const { provider, model } = resolveModel(rawModel);

  if (!provider.embed) {
    return jsonResponse(501, {
      error: {
        type: "not_implemented",
        message: `${capitalize(provider.id)} does not provide embeddings via this API. ` +
          `Configure an embeddings-capable provider (OpenAI text-embedding-3-*, Voyage, Cohere, or local Ollama) ` +
          `and request its model (e.g. "text-embedding-3-small" or "openai/text-embedding-3-small").`,
      },
    });
  }
  if (!provider.configured(env)) return providerNotConfigured(provider);
  return provider.embed({ body: { ...body, model }, model, env });
}

// GET /v1/models — aggregate the static model lists of every configured provider.
function handleModels(env: Env): Response {
  const nowSec = Math.floor(Date.now() / 1000);
  const data = allProviders()
    .filter((p) => p.configured(env))
    .flatMap((p) => p.models(nowSec));
  return jsonResponse(200, { object: "list", data });
}

const handler = {
  __skipJwtVerify: false as boolean,

  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // GET /v1/models is read-only; gated like everything else for simplicity.
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const denied = await authorize(req, env, handler.__skipJwtVerify);
      if (denied) return denied;
      return handleModels(env);
    }

    if (req.method !== "POST") {
      return jsonResponse(404, { error: { type: "not_found", message: "POST /v1/messages, POST /v1/chat/completions, GET /v1/models, or POST /v1/embeddings" } });
    }

    if (url.pathname === "/v1/embeddings") {
      const denied = await authorize(req, env, handler.__skipJwtVerify);
      if (denied) return denied;
      return handleEmbeddings(req, env);
    }

    if (url.pathname === "/v1/messages") {
      const denied = await authorize(req, env, handler.__skipJwtVerify);
      if (denied) return denied;
      return handleAnthropicMessages(req, env);
    }

    if (url.pathname === "/v1/chat/completions") {
      const denied = await authorize(req, env, handler.__skipJwtVerify);
      if (denied) return denied;
      return handleChatCompletions(req, env);
    }

    return jsonResponse(404, { error: { type: "not_found", message: "unknown route" } });
  },
};

export default handler;
