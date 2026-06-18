import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index.js";

const ENV_BASE = {
  TUNNEL_HOSTNAME: "tunnel.example.com",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_AUD: "test-aud",
  TUNNEL_ACCESS_CLIENT_ID: "cid",
  TUNNEL_ACCESS_CLIENT_SECRET: "csecret",
};
const ENV_OPENAI = { ...ENV_BASE, OPENAI_API_KEY: "sk-test-123" };

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

function chatReq(model: string, extra: Record<string, unknown> = {}): Request {
  return new Request("https://w.example.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
  });
}

describe("OpenAI provider — edge chat", () => {
  it("routes openai/gpt-4o to api.openai.com with the operator key and stripped model", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ id: "chatcmpl-x", object: "chat.completion", choices: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const res = await worker.fetch(chatReq("openai/gpt-4o"), ENV_OPENAI as never, makeCtx());
    expect(res.status).toBe(200);

    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("https://api.openai.com/v1/chat/completions");
    const init = call[1] as RequestInit;
    const h = new Headers(init.headers as HeadersInit);
    expect(h.get("authorization")).toBe("Bearer sk-test-123");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("gpt-4o");
  });

  it("routes a bare gpt-4o (no prefix) to openai via owns()", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await worker.fetch(chatReq("gpt-4o"), ENV_OPENAI as never, makeCtx());
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("honors OPENAI_BASE_URL override", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const env = { ...ENV_OPENAI, OPENAI_BASE_URL: "https://gw.local/v1/" };
    await worker.fetch(chatReq("openai/gpt-4o"), env as never, makeCtx());
    expect(fetchMock.mock.calls[0]![0]).toBe("https://gw.local/v1/chat/completions");
  });

  it("returns 503 (no upstream call) when openai is selected but not configured", async () => {
    const res = await worker.fetch(chatReq("openai/gpt-4o"), ENV_BASE as never, makeCtx());
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("provider_not_configured");
    expect(body.error.message).toMatch(/OPENAI_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves SSE passthrough for streaming openai chat", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    fetchMock.mockResolvedValueOnce(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const res = await worker.fetch(chatReq("openai/gpt-4o", { stream: true }), ENV_OPENAI as never, makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(await res.text()).toContain("[DONE]");
  });

  it("maps an openai network failure to a 502 OpenAI-shaped error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const res = await worker.fetch(chatReq("openai/gpt-4o"), ENV_OPENAI as never, makeCtx());
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("upstream_unavailable");
    expect(body.error.message).toMatch(/ECONNRESET/);
  });
});

describe("real /v1/embeddings", () => {
  it("serves openai embeddings when a text-embedding-3-* model is requested", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const req = new Request("https://w.example.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }),
    });
    const res = await worker.fetch(req, ENV_OPENAI as never, makeCtx());
    expect(res.status).toBe(200);

    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("https://api.openai.com/v1/embeddings");
    const body = JSON.parse((call[1] as RequestInit).body as string) as { model: string; input: string };
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toBe("hello");
  });

  it("still 501s embeddings routed to anthropic (the default provider, no embeddings API)", async () => {
    const req = new Request("https://w.example.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", input: "hi" }),
    });
    const res = await worker.fetch(req, ENV_OPENAI as never, makeCtx());
    expect(res.status).toBe(501);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("not_implemented");
    expect(body.error.message).toMatch(/Anthropic does not provide embeddings/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("503s embeddings when an openai embedding model is requested but openai is unconfigured", async () => {
    const req = new Request("https://w.example.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "hi" }),
    });
    const res = await worker.fetch(req, ENV_BASE as never, makeCtx());
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /v1/models — aggregation", () => {
  it("aggregates anthropic + openai models when openai is configured", async () => {
    const req = new Request("https://w.example.com/v1/models", { method: "GET" });
    const res = await worker.fetch(req, ENV_OPENAI as never, makeCtx());
    const body = await res.json() as { data: Array<{ id: string; owned_by: string }> };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("claude-haiku-4-5");
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("text-embedding-3-small");
    const owners = new Set(body.data.map((m) => m.owned_by));
    expect(owners.has("anthropic")).toBe(true);
    expect(owners.has("openai")).toBe(true);
  });

  it("omits openai models when openai is not configured", async () => {
    const req = new Request("https://w.example.com/v1/models", { method: "GET" });
    const res = await worker.fetch(req, ENV_BASE as never, makeCtx());
    const body = await res.json() as { data: Array<{ owned_by: string }> };
    const owners = new Set(body.data.map((m) => m.owned_by));
    expect(owners.has("anthropic")).toBe(true);
    expect(owners.has("openai")).toBe(false);
  });
});
