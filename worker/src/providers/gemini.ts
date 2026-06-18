// Google Gemini provider — edge-direct via Gemini's OpenAI-compatible endpoint
// (https://generativelanguage.googleapis.com/v1beta/openai/), which speaks the
// OpenAI wire format for both chat completions and embeddings.
import { makeOpenAICompatibleProvider } from "./openai-compatible.js";

export const geminiProvider = makeOpenAICompatibleProvider({
  id: "gemini",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKeyEnv: "GEMINI_API_KEY",
  baseUrlEnv: "GEMINI_BASE_URL",
  owns: /^gemini-/i,
  modelIds: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-embedding-001",
  ],
  capabilities: { chat: true, embed: true },
});
