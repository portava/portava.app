import type { DetectLanguageResult, TranslateTextResult, TranslationProvider } from './translation.js';

export class SelfHostedTranslationProvider implements TranslationProvider {
  constructor(private readonly config: { url?: string; token?: string; timeoutMs?: number } = {
    url: process.env.TRANSLATION_SELF_HOSTED_URL,
    token: process.env.TRANSLATION_SELF_HOSTED_TOKEN,
  }) {}

  private async request(operation: string, payload: Record<string, string>): Promise<Record<string, unknown>> {
    const { url, token } = this.config;
    if (!url || !token || token.length < 32) throw new Error('translation_unavailable');
    const endpoint = new URL(url);
    if (!['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.protocol !== 'http:'
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
      throw new Error('translation_endpoint_not_local');
    }
    if (Object.values(payload).some(value => value.length > 8_000)) throw new Error('translation_input_limit');
    endpoint.pathname = `/v1/${operation}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(this.config.timeoutMs ?? 5_000, 30_000)));
    try {
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
      if (!response.ok || !response.body) throw new Error('translation_unavailable');
      const reader = response.body.getReader();
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 128_000) throw new Error('translation_response_limit');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('translation_invalid_response');
      return data as Record<string, unknown>;
    } catch {
      throw new Error('translation_unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  async detectLanguage(text: string): Promise<DetectLanguageResult> {
    const data = await this.request('detect', { text });
    if (typeof data.language !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(data.language)
      || ['und', 'zxx'].includes(data.language) || !['high', 'low'].includes(String(data.confidence))) {
      throw new Error('translation_invalid_detection');
    }
    return { language: data.language, confidence: data.confidence as 'high' | 'low' };
  }

  async translateText(text: string, source: string, target: string): Promise<TranslateTextResult> {
    if (!text.trim() || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(source)
      || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(target)) throw new Error('translation_invalid_input');
    const data = await this.request('translate', { text, source, target });
    if (typeof data.translatedText !== 'string' || !data.translatedText.trim() || data.translatedText.length > 32_000
      || data.source !== source || data.target !== target || typeof data.providerVersion !== 'string'
      || !data.providerVersion.trim() || data.providerVersion.length > 160) throw new Error('translation_invalid_response');
    return { translatedText: data.translatedText, provider: 'self-hosted', providerVersion: data.providerVersion };
  }
}
