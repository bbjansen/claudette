// Shared HTTP helpers used by the gateway and provider adapters.

export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Stream an upstream Response back to the client, dropping hop-by-hop headers
// so the runtime re-frames the body. Preserves status + content-type, so SSE
// (`text/event-stream`) passes through untouched.
export function passThroughResponse(upstream: Awaited<ReturnType<typeof fetch>>): Response {
  const outHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    outHeaders.set(k, v);
  }
  return new Response(
    upstream.body as unknown as ReadableStream<Uint8Array> | null,
    { status: upstream.status, headers: outHeaders },
  );
}

// OpenAI-shaped error envelope, for edge providers that already speak OpenAI.
export function openaiError(status: number, message: string, type = "api_error", code = "upstream_error"): Response {
  return jsonResponse(status, { error: { message, type, code, param: null } });
}
