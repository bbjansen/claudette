// Cloudflare Tunnel transport: forwards a request to the residential Mac agent
// at https://<TUNNEL_HOSTNAME>/v1/messages. Used by the /v1/messages
// passthrough and by tunnel-transport provider adapters (Claude Max, Ollama).

import type { Env } from "./env.js";

// Request headers we forward to the tunnel for the /v1/messages passthrough.
// `anthropic-version` is intentionally NOT here: the agent always pins its own
// version upstream, so forwarding a client value would be silently overridden.
// `anthropic-beta` IS forwarded so the agent can merge the client's requested
// betas with the OAuth bearer beta it must add. `x-account-hint` lets a client
// pin a Max account for the session (warm prompt cache).
export const FORWARD_HEADERS = new Set([
  "accept",
  "content-type",
  "x-account-hint",
  "anthropic-beta",
]);

export function applyTunnelAuth(headers: Headers, env: Env): void {
  if (env.TUNNEL_ACCESS_CLIENT_ID && env.TUNNEL_ACCESS_CLIENT_SECRET) {
    headers.set("cf-access-client-id", env.TUNNEL_ACCESS_CLIENT_ID);
    headers.set("cf-access-client-secret", env.TUNNEL_ACCESS_CLIENT_SECRET);
  }
}

export function buildTunnelHeaders(req: Request, env: Env): Headers {
  const fwd = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (FORWARD_HEADERS.has(k.toLowerCase())) fwd.set(k, v);
  }
  applyTunnelAuth(fwd, env);
  return fwd;
}

export async function callTunnel(
  env: Env,
  body: BodyInit | null,
  headers: Headers,
): Promise<Awaited<ReturnType<typeof fetch>> | { error: string }> {
  try {
    return await fetch(`https://${env.TUNNEL_HOSTNAME}/v1/messages`, { method: "POST", headers, body });
  } catch (e) {
    return { error: (e as Error).message };
  }
}
