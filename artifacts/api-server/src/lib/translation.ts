/**
 * Translation provider abstraction.
 *
 * Interface + MockTranslationProvider (dev/test) + OpenAITranslationProvider.
 * Provider selection via env vars:
 *   TRANSLATION_PROVIDER        — 'mock' (default) | 'openai'
 *   TRANSLATION_ENABLED         — 'true' | 'false' (default 'true')
 *   TRANSLATION_TIMEOUT_MS      — number (default 8000)
 *
 * NEVER log full message body. Only log message_id, status, source/target, provider, error code.
 */

import { openai } from './openai';

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface DetectLanguageResult {
  language: string;   // ISO 639-1, e.g. 'en'
  confidence: 'high' | 'low';
}

export interface TranslateTextResult {
  translatedText: string;
  provider: string;
}

export interface TranslationProvider {
  detectLanguage(text: string): Promise<DetectLanguageResult>;
  translateText(text: string, source: string, target: string): Promise<TranslateTextResult>;
}

// ── Config ────────────────────────────────────────────────────────────────────

export const TRANSLATION_ENABLED =
  (process.env.TRANSLATION_ENABLED ?? 'true').toLowerCase() !== 'false';

export const TRANSLATION_TIMEOUT_MS =
  Number(process.env.TRANSLATION_TIMEOUT_MS ?? 8000);

// ── Mock provider ─────────────────────────────────────────────────────────────

const MOCK_LANGUAGE_MAP: Record<string, string> = {
  'hola': 'es', 'bonjour': 'fr', 'ciao': 'it', 'hallo': 'de',
  'こんにちは': 'ja', '안녕': 'ko', '你好': 'zh', 'olá': 'pt',
  'привет': 'ru', 'مرحبا': 'ar', 'สวัสดี': 'th',
};

export class MockTranslationProvider implements TranslationProvider {
  async detectLanguage(text: string): Promise<DetectLanguageResult> {
    const lower = text.toLowerCase();
    for (const [word, lang] of Object.entries(MOCK_LANGUAGE_MAP)) {
      if (lower.includes(word)) return { language: lang, confidence: 'low' };
    }
    return { language: 'en', confidence: 'low' };
  }

  async translateText(text: string, source: string, target: string): Promise<TranslateTextResult> {
    return {
      translatedText: `[translated from ${source}] ${text}`,
      provider: 'mock',
    };
  }
}

// ── OpenAI provider ───────────────────────────────────────────────────────────

const ISO_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese',
  ko: 'Korean', zh: 'Chinese', pt: 'Portuguese', it: 'Italian', ru: 'Russian',
  ar: 'Arabic', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', tl: 'Filipino',
  sv: 'Swedish', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', hi: 'Hindi',
};

export class OpenAITranslationProvider implements TranslationProvider {
  async detectLanguage(text: string): Promise<DetectLanguageResult> {
    const snippet = text.slice(0, 200);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a language detection utility. Respond with ONLY a JSON object: {"language":"<ISO 639-1 code>","confidence":"high"|"low"}. No other text.',
        },
        { role: 'user', content: snippet },
      ],
      max_tokens: 20,
      temperature: 0,
    });
    const raw = completion.choices[0]?.message?.content?.trim() ?? '{}';
    try {
      const parsed = JSON.parse(raw);
      return {
        language: parsed.language ?? 'en',
        confidence: parsed.confidence === 'high' ? 'high' : 'low',
      };
    } catch {
      return { language: 'en', confidence: 'low' };
    }
  }

  async translateText(text: string, source: string, target: string): Promise<TranslateTextResult> {
    const targetName = ISO_LANGUAGE_NAMES[target] ?? target;
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Translate the following message to ${targetName}. Respond with ONLY the translated text, preserving tone and emoji. Do not add explanations.`,
        },
        { role: 'user', content: text },
      ],
      max_tokens: 1000,
      temperature: 0.3,
    });
    const translated = completion.choices[0]?.message?.content?.trim();
    if (!translated) throw new Error('empty_response');
    return { translatedText: translated, provider: 'openai' };
  }
}

// ── Provider factory ──────────────────────────────────────────────────────────

let _provider: TranslationProvider | null = null;

export function getTranslationProvider(): TranslationProvider {
  if (_provider) return _provider;
  const name = (process.env.TRANSLATION_PROVIDER ?? 'mock').toLowerCase();
  if (name === 'openai') {
    _provider = new OpenAITranslationProvider();
  } else {
    _provider = new MockTranslationProvider();
  }
  return _provider;
}

/** ISO 639-1 → display name (e.g. 'es' → 'Spanish') */
export function languageDisplayName(iso: string): string {
  return ISO_LANGUAGE_NAMES[iso] ?? iso.toUpperCase();
}

/** For unit tests — inject a custom provider. */
export function _setTranslationProvider(p: TranslationProvider): void {
  _provider = p;
}
export function _clearTranslationProvider(): void {
  _provider = null;
}
