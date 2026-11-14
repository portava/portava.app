import OpenAI from "openai";

/** Keep each provider's URL and key together. Deployments outside Replit can
 * use the standard OpenAI variables instead of sending "not-configured". */
export function resolveOpenAIConfig(env: NodeJS.ProcessEnv) {
  const integrationBase = env.AI_INTEGRATIONS_OPENAI_BASE_URL?.trim();
  const integrationKey = env.AI_INTEGRATIONS_OPENAI_API_KEY?.trim();
  if (integrationBase && integrationKey) return { baseURL: integrationBase, apiKey: integrationKey };
  return {
    baseURL: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
    apiKey: env.OPENAI_API_KEY?.trim() || 'not-configured',
  };
}
const { baseURL, apiKey } = resolveOpenAIConfig(process.env);

if (apiKey === 'not-configured') {
  console.warn(
    "[telegraph] OpenAI credentials not set — recommendations will be unavailable",
  );
}

export const openai = new OpenAI({
  baseURL,
  apiKey,
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
