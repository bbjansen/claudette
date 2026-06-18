// OpenAI provider — edge-direct, the canonical OpenAI-compatible endpoint.
import { makeOpenAICompatibleProvider } from "./openai-compatible.js";

export const openaiProvider = makeOpenAICompatibleProvider({
  id: "openai",
  defaultBaseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  baseUrlEnv: "OPENAI_BASE_URL",
  owns: /^(gpt-|o[0-9]|chatgpt|text-embedding-|text-davinci|davinci-|babbage-|whisper-|tts-|dall-e)/i,
  modelIds: [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "o3",
    "o4-mini",
    "text-embedding-3-small",
    "text-embedding-3-large",
  ],
  capabilities: { chat: true, embed: true },
});
