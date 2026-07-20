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

// ── Test injection ────────────────────────────────────────────────────────────
// For unit tests only. Inject a mock before each test, restore to null after.
let _testOpenAI: OpenAI | null = null;

/** Inject a mock OpenAI client for tests. Pass null to restore the real client. */
export function _setTestOpenAI(mock: OpenAI | null): void {
  _testOpenAI = mock;
}

/** Returns the test-injected client when set; otherwise the real client. */
export function getOpenAI(): OpenAI {
  return _testOpenAI ?? openai;
}
