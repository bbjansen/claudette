import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index.js";

const ENV_BASE = {
  TUNNEL_HOSTNAME: "tunnel.example.com",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_AUD: "test-aud",
  TUNNEL_ACCESS_CLIENT_ID: "cid",
  TUNNEL_ACCESS_CLIENT_SECRET: "csecret",
};

function makeCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
}

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  (worker as unknown as { __skipJwtVerify: boolean }).__skipJwtVerify = true;
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  (worker as unknown as { __skipJwtVerify: boolean }).__skipJwtVerify = false;
});

function post(path: string, body: unknown): Request {
  return new Request(`https://w.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Ollama provider (tunnel transport)", () => {
  it("forwards ollama/* chat to the agent's /v1/ollama/chat/completions route with tunnel auth", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const res = await worker.fetch(
      post("/v1/chat/completions", { model: "ollama/llama3.2", messages: [{ role: "user", content: "hi" }] }),
      ENV_BASE as never, makeCtx(),
    );
    expect(res.status).toBe(200);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("https://tunnel.example.com/v1/ollama/chat/completions");
    const init = call[1] as RequestInit;
    const h = new Headers(init.headers as HeadersInit);
    expect(h.get("cf-access-client-id")).toBe("cid");
    expect(h.get("cf-access-client-secret")).toBe("csecret");
    expect((JSON.parse(init.body as string) as { model: string }).model).toBe("llama3.2");
  });

  it("forwards ollama/* embeddings to the agent's /v1/ollama/embeddings route", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }));
    const res = await worker.fetch(post("/v1/embeddings", { model: "ollama/nomic-embed-text", input: "hi" }), ENV_BASE as never, makeCtx());
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://tunnel.example.com/v1/ollama/embeddings");
  });

  it("a bare local model name (no ollama/ prefix) does NOT route to ollama", async () => {
    // "llama3.2" bare falls back to the default provider (anthropic), whose
    // tunnel path is /v1/messages — never /v1/ollama/*.
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await worker.fetch(
      post("/v1/chat/completions", { model: "llama3.2", messages: [{ role: "user", content: "hi" }] }),
      ENV_BASE as never, makeCtx(),
    );
    expect(fetchMock.mock.calls[0]![0]).toBe("https://tunnel.example.com/v1/messages");
  });

  it("maps a tunnel failure to a 502 OpenAI-shaped error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("tunnel down"));
    const res = await worker.fetch(
      post("/v1/chat/completions", { model: "ollama/llama3.2", messages: [{ role: "user", content: "hi" }] }),
      ENV_BASE as never, makeCtx(),
    );
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("upstream_unavailable");
    expect(body.error.message).toMatch(/tunnel down/);
  });
});
