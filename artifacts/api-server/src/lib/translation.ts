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

import { getOpenAI } from './openai';

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
  Number(process.env.TRANSLATION_TIMEOUT_MS ?? 5000);

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
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a language detection utility. Respond with ONLY a JSON object: {"language":"<ISO 639-1 code>","confidence":"high"|"low"}. No other text.',
        },
        { role: 'user', content: snippet },
      ],
      max_completion_tokens: 200,
      reasoning_effort: 'minimal' as const,
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
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        {
          role: 'system',
          content: `Translate the following message to ${targetName}. Respond with ONLY the translated text, preserving tone and emoji. Do not add explanations.`,
        },
        { role: 'user', content: text },
      ],
      max_completion_tokens: 2000,
      reasoning_effort: 'minimal' as const,
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

/**
 * Test-only: inject a custom provider and clear it after the test.
 * Never call this in production code.
 */
export function _setTestTranslationProvider(p: TranslationProvider | null): void {
  _provider = p;
}

/** ISO 639-1 → display name (e.g. 'es' → 'Spanish') */
export function languageDisplayName(iso: string): string {
  return ISO_LANGUAGE_NAMES[iso] ?? iso.toUpperCase();
}

// ── Translation validator ─────────────────────────────────────────────────────

export type ValidationFailureReason = 'empty' | 'too_short' | 'identical' | 'truncated';

export interface ValidationOutcome {
  valid: boolean;
  reason?: ValidationFailureReason;
}

/**
 * Sentence-terminal punctuation set (covers Latin, CJK, ellipsis, Devanagari
 * danda/double danda, and Arabic question mark / full stop).
 * A translation whose original ends with terminal punctuation but whose
 * translation does not is considered potentially truncated.
 */
const SENTENCE_TERMINAL_RE = /[.!?。！？…\u0964\u0965\u061F\u06D4]$/u;

/**
 * Languages whose script has no dedicated sentence-terminal punctuation mark
 * (sentences are conventionally separated by a space or simply run on) — rule
 * 4 must be skipped entirely for these, since it would otherwise reject every
 * translation whose source ends in a full stop.
 */
const NO_TERMINAL_PUNCT_LANGS = new Set(['th', 'lo', 'km', 'my']);

/**
 * Target languages whose scripts compress Latin source text hard (CJK) — a
 * correct, complete translation can legitimately be far shorter than 20% of
 * the source character count, so rule 2's floor is relaxed for them.
 */
const COMPACT_SCRIPT_LANGS = new Set(['zh', 'zh-TW', 'ja', 'ko']);
const COMPACT_SCRIPT_MIN_RATIO = 0.08;
const DEFAULT_MIN_RATIO = 0.2;

/**
 * validateTranslation — returns whether a translation result is safe to show.
 *
 * Rules (in order):
 *  1. Non-empty / non-whitespace
 *  2. At least `minRatio` (20%, or 8% for compact CJK targets) the character
 *     length of the original
 *  3. Not character-identical to the original (no-op translation)
 *  4. If original ends with sentence-terminal punctuation, translation must
 *     too (guards against mid-sentence truncation) — skipped for target
 *     languages whose script has no terminal punctuation at all
 *
 * @param targetLanguage - ISO 639-1 (or zh-TW) code of the translation's
 *   target language. Optional for backward compatibility; when omitted,
 *   rules 2 and 4 fall back to their previous language-agnostic behavior.
 *
 * Privacy: callers must never log the original or translated text themselves.
 */
export function validateTranslation(
  original: string,
  translated: string,
  targetLanguage?: string,
): ValidationOutcome {
  const origTrimmed = original.trim();
  const transTrimmed = translated.trim();

  if (!transTrimmed) {
    return { valid: false, reason: 'empty' };
  }

  const minRatio = targetLanguage && COMPACT_SCRIPT_LANGS.has(targetLanguage)
    ? COMPACT_SCRIPT_MIN_RATIO
    : DEFAULT_MIN_RATIO;

  if (origTrimmed.length > 0 && transTrimmed.length < origTrimmed.length * minRatio) {
    return { valid: false, reason: 'too_short' };
  }

  if (transTrimmed === origTrimmed) {
    return { valid: false, reason: 'identical' };
  }

  const skipTerminalCheck = !!targetLanguage && NO_TERMINAL_PUNCT_LANGS.has(targetLanguage);
  if (
    !skipTerminalCheck &&
    SENTENCE_TERMINAL_RE.test(origTrimmed) &&
    !SENTENCE_TERMINAL_RE.test(transTrimmed)
  ) {
    return { valid: false, reason: 'truncated' };
  }

  return { valid: true };
}

/** For unit tests — inject a custom provider. */
export function _setTranslationProvider(p: TranslationProvider): void {
  _provider = p;
}
export function _clearTranslationProvider(): void {
  _provider = null;
}
