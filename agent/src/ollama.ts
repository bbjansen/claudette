// Local Ollama proxy. The Worker forwards Ollama-routed (ollama/*) requests
// over the CF Tunnel to the agent, which relays them to the operator's local
// Ollama server's OpenAI-compatible endpoint (http://localhost:11434/v1 by
// default). Ollama needs no API key; reachability is the only requirement.

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";

export type OllamaForwarder = (subpath: string, body: Buffer, accept: string) => Promise<Response>;

export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OLLAMA_BASE_URL;
  const base = raw && raw.length > 0 ? raw : DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "");
}

// Builds a forwarder bound to `baseUrl`. `fetchImpl` is injectable for tests.
export function makeOllamaForwarder(baseUrl: string, fetchImpl: typeof fetch = fetch): OllamaForwarder {
  return async (subpath, body, accept) => {
    const url = `${baseUrl}/${subpath}`;
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept },
        body: body as unknown as BodyInit,
      });
    } catch (e) {
      return new Response(
        JSON.stringify({
          error: { type: "upstream_unavailable", message: `ollama unreachable at ${url}: ${(e as Error).message}` },
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
  };
}
