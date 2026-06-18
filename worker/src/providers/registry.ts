// Provider registry + model router.
//
// Resolution precedence for a requested model name:
//   1. Explicit "provider/model" prefix (e.g. "openai/gpt-4o") — always wins.
//   2. A provider that owns() the bare name (e.g. "gpt-4o" → openai,
//      "claude-haiku-4-5" → anthropic). First match in registry order.
//   3. The default provider (anthropic), so legacy bare Claude clients keep
//      working unchanged.
//
// Resolution is independent of whether the provider is configured — the
// gateway checks configured() at dispatch and returns 503 with a setup hint.

import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import type { Provider } from "./types.js";

const REGISTRY: Provider[] = [anthropicProvider, openaiProvider];
const DEFAULT_PROVIDER: Provider = anthropicProvider;

export interface Resolution {
  provider: Provider;
  // Model with any "provider/" prefix stripped.
  model: string;
  // True when the prefix was explicit (so a configured-but-wrong-prefix request
  // is not silently rerouted by owns()).
  explicit: boolean;
}

export function resolveModel(rawModel: string): Resolution {
  const slash = rawModel.indexOf("/");
  if (slash > 0) {
    const prefix = rawModel.slice(0, slash);
    const rest = rawModel.slice(slash + 1);
    const byPrefix = REGISTRY.find((p) => p.id === prefix);
    if (byPrefix && rest.length > 0) return { provider: byPrefix, model: rest, explicit: true };
  }
  const byOwns = REGISTRY.find((p) => p.owns(rawModel));
  if (byOwns) return { provider: byOwns, model: rawModel, explicit: false };
  return { provider: DEFAULT_PROVIDER, model: rawModel, explicit: false };
}

export function allProviders(): Provider[] {
  return REGISTRY;
}
