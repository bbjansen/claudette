// Voyage AI provider — edge-direct, dedicated embeddings. Voyage's
// /v1/embeddings is OpenAI-compatible for the common case ({model, input} →
// {object:"list", data:[{embedding,index}]}), so it passes straight through.
// Voyage-specific options (input_type, output_dimension, …) are not translated;
// clients that need them can send them and Voyage will honor them. No chat API.
import { makeOpenAICompatibleProvider } from "./openai-compatible.js";

export const voyageProvider = makeOpenAICompatibleProvider({
  id: "voyage",
  defaultBaseUrl: "https://api.voyageai.com/v1",
  apiKeyEnv: "VOYAGE_API_KEY",
  baseUrlEnv: "VOYAGE_BASE_URL",
  owns: /^voyage-/i,
  modelIds: [
    "voyage-3.5",
    "voyage-3.5-lite",
    "voyage-3-large",
    "voyage-code-3",
  ],
  capabilities: { chat: false, embed: true },
});
