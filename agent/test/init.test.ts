import { describe, it, expect } from "vitest";
import { parseNodeMajor, checkPrereqs, prereqsSatisfied, type Prereq } from "../src/init/prereqs.js";
import { secretPlan, parseSelection, CONFIGURABLE_PROVIDERS } from "../src/init/providers.js";
import { generateProxyKey, proxyKeyPath } from "../src/init/keyfile.js";
import { tunnelCommands, usageSnippet, buildSetupSummary, type WizardState } from "../src/init/plan.js";

describe("prereqs", () => {
  it("parses the node major version", () => {
    expect(parseNodeMajor("v20.11.1")).toBe(20);
    expect(parseNodeMajor("22.3.0")).toBe(22);
    expect(parseNodeMajor("not-a-version")).toBeNull();
  });

  it("flags node < 20 as not ok and surfaces the hint", async () => {
    const prereqs: Prereq[] = [{ name: "node", cmd: "node", args: ["--version"], required: true, hint: "Install Node 20+" }];
    const run = async () => ({ ok: true, stdout: "v18.19.0\n" });
    const [r] = await checkPrereqs(run, prereqs);
    expect(r!.ok).toBe(false);
    expect(r!.detail).toMatch(/need >= 20/);
  });

  it("marks a missing required tool as not found, and prereqsSatisfied honors required", async () => {
    const prereqs: Prereq[] = [
      { name: "cloudflared", cmd: "cloudflared", args: ["--version"], required: true, hint: "brew install cloudflared" },
      { name: "jq", cmd: "jq", args: ["--version"], required: false, hint: "optional" },
    ];
    const run = async (cmd: string) => (cmd === "jq" ? { ok: false, stdout: "" } : { ok: false, stdout: "" });
    const results = await checkPrereqs(run, prereqs);
    expect(results.find((r) => r.name === "cloudflared")!.ok).toBe(false);
    expect(prereqsSatisfied(results)).toBe(false); // required cloudflared missing

    const run2 = async (cmd: string) => (cmd === "cloudflared" ? { ok: true, stdout: "cloudflared version 2024" } : { ok: false, stdout: "" });
    const results2 = await checkPrereqs(run2, prereqs);
    expect(prereqsSatisfied(results2)).toBe(true); // only optional jq missing
  });
});

describe("provider selection", () => {
  it("maps a selection to the cloud-provider Worker secrets (in catalog order)", () => {
    expect(secretPlan(["voyage", "openai"]).map((s) => s.env)).toEqual(["OPENAI_API_KEY", "VOYAGE_API_KEY"]);
  });

  it("omits local providers (ollama has no secret)", () => {
    expect(secretPlan(["ollama"]).length).toBe(0);
  });

  it("parses a comma/space selection and reports unknowns", () => {
    const r = parseSelection("openai, gemini  bogus");
    expect(r.selected).toEqual(["openai", "gemini"]);
    expect(r.unknown).toEqual(["bogus"]);
  });

  it("the catalog covers the four configurable providers", () => {
    expect(CONFIGURABLE_PROVIDERS.map((p) => p.id).sort()).toEqual(["gemini", "ollama", "openai", "voyage"]);
  });
});

describe("keyfile", () => {
  it("generates a 64-hex-char proxy key", () => {
    const k = generateProxyKey();
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(generateProxyKey()).not.toBe(k); // random
  });

  it("resolves the key path under home", () => {
    expect(proxyKeyPath("/Users/x")).toBe("/Users/x/.conduit.key");
  });
});

describe("plan", () => {
  const base: WizardState = {
    workerName: "conduit",
    proxyKeyPath: "/home/me/.conduit.key",
    proxyKeySaved: true,
    tunnelHostname: "conduit-agent.example.com",
    selectedProviderIds: ["openai"],
    secretsSet: ["PROXY_KEY", "OPENAI_API_KEY"],
    deployed: true,
    workerUrl: "https://conduit.acme.workers.dev",
  };

  it("builds tunnel commands using the provided hostname", () => {
    const cmds = tunnelCommands(base);
    expect(cmds.some((c) => c.includes("cloudflared tunnel create conduit"))).toBe(true);
    expect(cmds.some((c) => c.includes("conduit-agent.example.com"))).toBe(true);
  });

  it("usage snippet uses the resolved worker URL + key path", () => {
    const snip = usageSnippet(base);
    expect(snip).toContain("https://conduit.acme.workers.dev/v1/chat/completions");
    expect(snip).toContain("/home/me/.conduit.key");
  });

  it("summary reflects deployed state, set secrets, and pending secrets", () => {
    const pending: WizardState = { ...base, selectedProviderIds: ["openai", "gemini"], secretsSet: ["OPENAI_API_KEY"] };
    const summary = buildSetupSummary(pending);
    expect(summary).toContain("conduit");
    expect(summary).toMatch(/Secrets set:\s+OPENAI_API_KEY/);
    expect(summary).toMatch(/Secrets TODO:\s+GEMINI_API_KEY/);
    expect(summary).toContain("login --acct");
  });
});
