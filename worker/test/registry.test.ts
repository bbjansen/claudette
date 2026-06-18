import { describe, it, expect } from "vitest";
import { resolveModel, allProviders } from "../src/providers/registry.js";

describe("resolveModel — routing precedence", () => {
  it("routes an explicit openai/ prefix to openai and strips the prefix", () => {
    const r = resolveModel("openai/gpt-4o");
    expect(r.provider.id).toBe("openai");
    expect(r.model).toBe("gpt-4o");
    expect(r.explicit).toBe(true);
  });

  it("routes an explicit anthropic/ prefix to anthropic", () => {
    const r = resolveModel("anthropic/claude-opus-4-8");
    expect(r.provider.id).toBe("anthropic");
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.explicit).toBe(true);
  });

  it("routes bare claude-* to anthropic via owns()", () => {
    const r = resolveModel("claude-haiku-4-5");
    expect(r.provider.id).toBe("anthropic");
    expect(r.model).toBe("claude-haiku-4-5");
    expect(r.explicit).toBe(false);
  });

  it("routes bare openai model families to openai via owns()", () => {
    expect(resolveModel("gpt-4o").provider.id).toBe("openai");
    expect(resolveModel("gpt-4.1-mini").provider.id).toBe("openai");
    expect(resolveModel("o3").provider.id).toBe("openai");
    expect(resolveModel("text-embedding-3-small").provider.id).toBe("openai");
  });

  it("routes bare gemini-* and voyage-* to their providers via owns()", () => {
    expect(resolveModel("gemini-2.5-pro").provider.id).toBe("gemini");
    expect(resolveModel("gemini-embedding-001").provider.id).toBe("gemini");
    expect(resolveModel("voyage-3.5").provider.id).toBe("voyage");
    expect(resolveModel("voyage/voyage-3.5")).toMatchObject({ provider: { id: "voyage" }, model: "voyage-3.5", explicit: true });
  });

  it("falls back to the default provider (anthropic) for unknown bare names", () => {
    const r = resolveModel("mystery-model-9000");
    expect(r.provider.id).toBe("anthropic");
    expect(r.model).toBe("mystery-model-9000");
  });

  it("does not silently reroute an unknown prefix — falls through to default", () => {
    const r = resolveModel("unknownprov/gpt-4o");
    expect(r.provider.id).toBe("anthropic");
    expect(r.model).toBe("unknownprov/gpt-4o");
  });

  it("treats an empty model name as the default provider", () => {
    expect(resolveModel("").provider.id).toBe("anthropic");
  });
});

describe("allProviders", () => {
  it("exposes anthropic, openai, gemini, and voyage", () => {
    const ids = allProviders().map((p) => p.id).sort();
    expect(ids).toEqual(["anthropic", "gemini", "openai", "voyage"]);
  });

  it("anthropic is tunnel transport + always configured; edge providers are key-gated", () => {
    const anthropic = allProviders().find((p) => p.id === "anthropic")!;
    const openai = allProviders().find((p) => p.id === "openai")!;
    const gemini = allProviders().find((p) => p.id === "gemini")!;
    const voyage = allProviders().find((p) => p.id === "voyage")!;

    expect(anthropic.transport).toBe("tunnel");
    expect(anthropic.configured({} as never)).toBe(true);

    expect(openai.transport).toBe("edge");
    expect(openai.configured({} as never)).toBe(false);
    expect(openai.configured({ OPENAI_API_KEY: "sk-x" } as never)).toBe(true);
    expect(gemini.configured({ GEMINI_API_KEY: "g-x" } as never)).toBe(true);
    expect(voyage.configured({ VOYAGE_API_KEY: "v-x" } as never)).toBe(true);
  });

  it("capability flags: anthropic chat-only, voyage embed-only, openai/gemini both", () => {
    const byId = (id: string) => allProviders().find((p) => p.id === id)!;
    expect(typeof byId("anthropic").chat).toBe("function");
    expect(byId("anthropic").embed).toBeUndefined();
    expect(byId("voyage").chat).toBeUndefined();
    expect(typeof byId("voyage").embed).toBe("function");
    expect(typeof byId("openai").chat).toBe("function");
    expect(typeof byId("openai").embed).toBe("function");
    expect(typeof byId("gemini").chat).toBe("function");
    expect(typeof byId("gemini").embed).toBe("function");
  });
});
