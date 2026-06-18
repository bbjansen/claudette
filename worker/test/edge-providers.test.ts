import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index.js";

const ENV_BASE = {
  TUNNEL_HOSTNAME: "tunnel.example.com",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_AUD: "test-aud",
  TUNNEL_ACCESS_CLIENT_ID: "cid",
  TUNNEL_ACCESS_CLIENT_SECRET: "csecret",
};
const ENV_ALL = { ...ENV_BASE, GEMINI_API_KEY: "g-test", VOYAGE_API_KEY: "v-test" };

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

describe("Gemini provider (edge, OpenAI-compatible)", () => {
  it("routes gemini/* chat to the Gemini OpenAI endpoint with the operator key", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const res = await worker.fetch(
      post("/v1/chat/completions", { model: "gemini/gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
      ENV_ALL as never, makeCtx(),
    );
    expect(res.status).toBe(200);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    const init = call[1] as RequestInit;
    expect(new Headers(init.headers as HeadersInit).get("authorization")).toBe("Bearer g-test");
    expect((JSON.parse(init.body as string) as { model: string }).model).toBe("gemini-2.5-flash");
  });

  it("routes a bare gemini-embedding-001 to Gemini embeddings", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }));
    const res = await worker.fetch(post("/v1/embeddings", { model: "gemini-embedding-001", input: "hi" }), ENV_ALL as never, makeCtx());
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://generativelanguage.googleapis.com/v1beta/openai/embeddings");
  });

  it("503s gemini when unconfigured", async () => {
    const res = await worker.fetch(
      post("/v1/chat/completions", { model: "gemini/gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
      ENV_BASE as never, makeCtx(),
    );
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Voyage provider (edge, embeddings-only)", () => {
  it("serves voyage-* embeddings", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ object: "list", data: [{ embedding: [0.1], index: 0 }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await worker.fetch(post("/v1/embeddings", { model: "voyage-3.5", input: "hi" }), ENV_ALL as never, makeCtx());
    expect(res.status).toBe(200);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("https://api.voyageai.com/v1/embeddings");
    expect(new Headers((call[1] as RequestInit).headers as HeadersInit).get("authorization")).toBe("Bearer v-test");
  });

  it("501s a chat-completions request routed to voyage (embeddings-only)", async () => {
    const res = await worker.fetch(
      post("/v1/chat/completions", { model: "voyage/voyage-3.5", messages: [{ role: "user", content: "hi" }] }),
      ENV_ALL as never, makeCtx(),
    );
    expect(res.status).toBe(501);
    const body = await res.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("not_implemented");
    expect(body.error.message).toMatch(/embeddings-only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /v1/models aggregates every configured edge provider", () => {
  it("includes gemini + voyage models when their keys are set", async () => {
    const res = await worker.fetch(new Request("https://w.example.com/v1/models", { method: "GET" }), ENV_ALL as never, makeCtx());
    const body = await res.json() as { data: Array<{ id: string; owned_by: string }> };
    const owners = new Set(body.data.map((m) => m.owned_by));
    expect(owners.has("anthropic")).toBe(true);
    expect(owners.has("gemini")).toBe(true);
    expect(owners.has("voyage")).toBe(true);
    expect(owners.has("openai")).toBe(false); // no OPENAI_API_KEY in ENV_ALL
  });
});
