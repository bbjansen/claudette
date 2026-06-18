export interface Env {
  TUNNEL_HOSTNAME: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  TUNNEL_ACCESS_CLIENT_ID: string;
  TUNNEL_ACCESS_CLIENT_SECRET: string;
  // Optional shared-bearer fallback for inbound auth, used when CF Access is
  // not (yet) configured in front of the Worker. When CF Access is in place,
  // requests carry Cf-Access-Jwt-Assertion and this is unused.
  PROXY_KEY?: string;

  // --- Providers (operator-stored secrets; edge transport) ---
  // Each edge provider speaks the OpenAI wire format. The key enables the
  // provider; the optional *_BASE_URL overrides its endpoint (compat gateway).

  // OpenAI: chat completions + embeddings.
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;

  // Google Gemini: chat + embeddings via its /v1beta/openai/ endpoint.
  GEMINI_API_KEY?: string;
  GEMINI_BASE_URL?: string;

  // Voyage AI: dedicated embeddings.
  VOYAGE_API_KEY?: string;
  VOYAGE_BASE_URL?: string;
}
