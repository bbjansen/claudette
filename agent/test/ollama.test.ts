import { describe, it, expect, vi } from "vitest";
import { ollamaBaseUrl, makeOllamaForwarder } from "../src/ollama.js";

describe("ollamaBaseUrl", () => {
  it("defaults to localhost:11434/v1", () => {
    expect(ollamaBaseUrl({} as NodeJS.ProcessEnv)).toBe("http://127.0.0.1:11434/v1");
  });
  it("honors OLLAMA_BASE_URL and strips trailing slashes", () => {
    expect(ollamaBaseUrl({ OLLAMA_BASE_URL: "http://host:1234/v1/" } as NodeJS.ProcessEnv)).toBe("http://host:1234/v1");
  });
});

describe("makeOllamaForwarder", () => {
  it("POSTs to <base>/<subpath> with the body + accept and returns the upstream response", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const fwd = makeOllamaForwarder("http://127.0.0.1:11434/v1", fetchImpl as unknown as typeof fetch);

    const res = await fwd("chat/completions", Buffer.from('{"model":"llama3.2"}'), "text/event-stream");
    expect(res.status).toBe(200);

    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("http://127.0.0.1:11434/v1/chat/completions");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["accept"]).toBe("text/event-stream");
  });

  it("returns a 502 OpenAI-shaped error when Ollama is unreachable", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const fwd = makeOllamaForwarder("http://127.0.0.1:11434/v1", fetchImpl as unknown as typeof fetch);

    const res = await fwd("embeddings", Buffer.from("{}"), "application/json");
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("upstream_unavailable");
    expect(body.error.message).toMatch(/ECONNREFUSED/);
  });
});
