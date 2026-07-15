import OpenAI from "openai";

const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

if (!baseURL || !apiKey) {
  console.warn(
    "[telegraph] OpenAI integration env vars not set — recommendations will be unavailable",
  );
}

export const openai = new OpenAI({
  baseURL: baseURL ?? "https://api.openai.com/v1",
  apiKey: apiKey ?? "not-configured",
});
