import { createHash } from 'node:crypto';
import {
  getSelfHostedTranslationProvider,
  translatePreservingEntities,
  validateTranslation,
  type TranslationProvider,
} from '../lib/translation.js';

export interface TranslationSubject {
  revision: string;
  protection: 'server-readable' | 'e2ee';
  sourceLanguage: string;
  fields: Record<string, string>;
  preferences: { enabled: boolean; targetLanguage?: string };
}

export interface PlatformTranslationRequest {
  viewerId: string;
  subjectId: string;
  targetLanguage: string;
}

export type PlatformTranslationResult =
  | { status: 'translated'; fields: Record<string, string>; sourceRevision: string; sourceLanguage: string; targetLanguage: string; provider: string; providerVersion: string }
  | { status: 'skipped'; fields: Record<string, never> }
  | { status: 'unavailable'; fields: Record<string, never> }
  | { status: 'denied'; fields: Record<string, never> };

export function createAuthorizedTranslationService(options: {
  loadAuthorizedSubject: (request: PlatformTranslationRequest) => Promise<TranslationSubject | null>;
  provider?: () => TranslationProvider;
  enabled?: () => boolean;
  now?: () => number;
}) {
  const cache = new Map<string, { expires: number; subjectId: string; result: PlatformTranslationResult }>();
  const now = options.now ?? Date.now;
  const fingerprint = (subject: TranslationSubject) => createHash('sha256')
    .update(JSON.stringify([subject.revision, subject.protection, subject.sourceLanguage,
      Object.entries(subject.fields).sort(([left], [right]) => left.localeCompare(right)), subject.preferences]))
    .digest('hex');
  const empty = (status: 'skipped' | 'unavailable' | 'denied'): PlatformTranslationResult => ({ status, fields: {} });

  return {
    clear() { cache.clear(); },
    async translate(request: PlatformTranslationRequest): Promise<PlatformTranslationResult> {
      try {
        const deadline = now() + 30_000;
        if (!request.viewerId || !request.subjectId || ['und', 'zxx'].includes(request.targetLanguage.toLowerCase())
          || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(request.targetLanguage)) return empty('denied');
        const subject = await options.loadAuthorizedSubject(request);
        if (!subject || subject.protection !== 'server-readable') {
          for (const [key, entry] of cache) if (entry.subjectId === request.subjectId) cache.delete(key);
          return empty('denied');
        }
        if (!subject.preferences.enabled || (subject.preferences.targetLanguage && subject.preferences.targetLanguage.toLowerCase() !== request.targetLanguage.toLowerCase())
          || options.enabled?.() === false || subject.sourceLanguage.toLowerCase() === request.targetLanguage.toLowerCase()) return empty('skipped');
        if (!subject.revision || ['und', 'zxx'].includes(subject.sourceLanguage.toLowerCase())
          || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(subject.sourceLanguage)) return empty('unavailable');
        const fields = Object.entries(subject.fields);
        if (!fields.length || fields.length > 100 || fields.some(([, value]) => typeof value !== 'string' || value.length > 8_000)
          || fields.reduce((size, [, value]) => size + value.length, 0) > 32_000) return empty('unavailable');
        const stamp = fingerprint(subject);
        const key = createHash('sha256').update(JSON.stringify([request.viewerId, request.subjectId, request.targetLanguage, stamp])).digest('hex');
        for (const [storedKey, entry] of cache) if (entry.expires <= now()) cache.delete(storedKey);
        let result = cache.get(key)?.result;
        if (!result) {
          const provider = (options.provider ?? getSelfHostedTranslationProvider)();
          const translated: Record<string, string> = Object.create(null);
          let identity: { provider: string; providerVersion: string } | undefined;
          for (const [field, original] of fields) {
            if (now() >= deadline) return empty('unavailable');
            if (!original.trim()) { translated[field] = original; continue; }
            const output = await translatePreservingEntities(provider, original, subject.sourceLanguage, request.targetLanguage);
            if (!validateTranslation(original, output.translatedText, request.targetLanguage).valid) return empty('unavailable');
            if (identity && (identity.provider !== output.provider || identity.providerVersion !== output.providerVersion)) return empty('unavailable');
            identity = output;
            translated[field] = output.translatedText;
            if (Object.values(translated).reduce((size, value) => size + value.length, 0) > 64_000) return empty('unavailable');
          }
          if (!identity) return empty('skipped');
          result = { status: 'translated', fields: translated, sourceRevision: subject.revision, sourceLanguage: subject.sourceLanguage,
            targetLanguage: request.targetLanguage, provider: identity.provider, providerVersion: identity.providerVersion };
        }
        const latest = await options.loadAuthorizedSubject(request);
        if (!latest || latest.protection !== 'server-readable' || fingerprint(latest) !== stamp || options.enabled?.() === false) {
          cache.delete(key);
          return empty('denied');
        }
        if (!cache.has(key)) {
          while (cache.size >= 64) cache.delete(cache.keys().next().value!);
          cache.set(key, { expires: now() + 60_000, subjectId: request.subjectId, result });
        }
        return structuredClone(result);
      } catch {
        return empty('unavailable');
      }
    },
  };
}
