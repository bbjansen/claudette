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

  // --- Phase 2 providers (operator-stored secrets; edge transport) ---
  // OpenAI: chat completions + embeddings, called directly from the edge.
  OPENAI_API_KEY?: string;
  // Optional base-URL override (default https://api.openai.com/v1) — lets an
  // operator point the OpenAI adapter at an OpenAI-compatible gateway.
  OPENAI_BASE_URL?: string;
}
