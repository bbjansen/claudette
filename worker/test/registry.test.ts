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
  it("exposes anthropic and openai", () => {
    const ids = allProviders().map((p) => p.id).sort();
    expect(ids).toEqual(["anthropic", "openai"]);
  });

  it("anthropic is tunnel transport + always configured; openai is edge + key-gated", () => {
    const anthropic = allProviders().find((p) => p.id === "anthropic")!;
    const openai = allProviders().find((p) => p.id === "openai")!;
    expect(anthropic.transport).toBe("tunnel");
    expect(anthropic.configured({} as never)).toBe(true);
    expect(openai.transport).toBe("edge");
    expect(openai.configured({} as never)).toBe(false);
    expect(openai.configured({ OPENAI_API_KEY: "sk-x" } as never)).toBe(true);
  });
});
