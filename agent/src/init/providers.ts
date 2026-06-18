// Catalog of optional providers the wizard can configure, plus the mapping from
// a selection to the Worker secrets that must be set. Anthropic (Claude Max) is
// always on via OAuth and is not listed here.

export interface ConfigurableProvider {
  id: string;
  label: string;
  // Worker secret to set for a cloud provider; undefined for local (Ollama).
  secretEnv?: string;
  kind: "cloud" | "local";
  note: string;
}

export const CONFIGURABLE_PROVIDERS: ConfigurableProvider[] = [
  { id: "openai", label: "OpenAI — chat + embeddings", secretEnv: "OPENAI_API_KEY", kind: "cloud", note: "gpt-*, o*, text-embedding-3-*" },
  { id: "gemini", label: "Google Gemini — chat + embeddings", secretEnv: "GEMINI_API_KEY", kind: "cloud", note: "gemini-*" },
  { id: "voyage", label: "Voyage AI — embeddings", secretEnv: "VOYAGE_API_KEY", kind: "cloud", note: "voyage-*" },
  { id: "ollama", label: "Local Ollama — chat + embeddings", kind: "local", note: "ollama/<model>; runs on your machine (no key)" },
];

export function providerById(id: string): ConfigurableProvider | undefined {
  return CONFIGURABLE_PROVIDERS.find((p) => p.id === id);
}

// Worker secrets to set for the selected cloud providers, in catalog order.
export function secretPlan(selectedIds: string[]): Array<{ env: string; label: string }> {
  return CONFIGURABLE_PROVIDERS
    .filter((p) => selectedIds.includes(p.id) && p.secretEnv)
    .map((p) => ({ env: p.secretEnv!, label: p.label }));
}

// Parse a comma/space-separated selection ("openai, gemini") against the
// catalog, returning the known ids (deduped, in catalog order) and any unknowns.
export function parseSelection(input: string): { selected: string[]; unknown: string[] } {
  const tokens = input.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const known = new Set(CONFIGURABLE_PROVIDERS.map((p) => p.id));
  const unknown = tokens.filter((t) => !known.has(t));
  const selected = CONFIGURABLE_PROVIDERS.map((p) => p.id).filter((id) => tokens.includes(id));
  return { selected, unknown };
}
