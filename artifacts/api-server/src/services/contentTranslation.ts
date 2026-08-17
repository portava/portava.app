/**
 * ContentTranslationService
 *
 * On-demand translation for public/shared content: posts, comments, events,
 * trips, and bios.  Uses the same provider abstraction as messageTranslation.ts
 * but stores results in `content_translations` keyed by
 * (entity_type, entity_id, target_language).
 *
 * Privacy: never logs full text. Only entity_type, entity_id, status, codes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import {
  getTranslationProvider,
  TRANSLATION_ENABLED,
  TRANSLATION_TIMEOUT_MS,
  languageDisplayName,
  validateTranslation,
} from '../lib/translation';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ContentEntityType = 'post' | 'comment' | 'event' | 'trip' | 'bio';

export interface TranslatedFields {
  /** post caption */
  content?: string;
  /** comment body */
  body?: string;
  /** event / trip title */
  title?: string;
  /** event description */
  description?: string;
  /** trip notes */
  trip_notes?: string;
  /** profile bio */
  bio?: string;
}

export interface ContentTranslationResult {
  entityType: ContentEntityType;
  entityId: string;
  sourceLanguage: string;
  targetLanguage: string;
  translatedFields: TranslatedFields;
  translationLabel: string;   // e.g. "Translated from Spanish"
  status: 'translated' | 'failed' | 'skipped';
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('translation_timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function translateWithRetry(
  text: string,
  source: string,
  target: string,
  maxRetries = 1,
): Promise<{ translatedText: string; provider: string }> {
  const prov = getTranslationProvider();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(prov.translateText(text, source, target), TRANSLATION_TIMEOUT_MS);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function detectWithRetry(text: string, maxRetries = 1): Promise<string> {
  const prov = getTranslationProvider();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await withTimeout(prov.detectLanguage(text), TRANSLATION_TIMEOUT_MS);
      return r.language;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ── Write-time: language detection ────────────────────────────────────────────

/**
 * Detect the language of `text` and write `original_language` onto the entity
 * row.  Called fire-and-forget after creating/updating posts, comments, events,
 * trips, and bios. Never throws.
 */
export async function detectAndStoreLanguage(
  sc: SupabaseClient,
  entityType: ContentEntityType,
  entityId: string,
  text: string,
  logger?: Logger,
): Promise<void> {
  if (!TRANSLATION_ENABLED) return;
  if (!text.trim()) return;

  try {
    const lang = await detectWithRetry(text);

    // Use static table names so the write-path column checker can verify them.
    if (entityType === 'post') {
      await sc.from('posts').update({ original_language: lang }).eq('id', entityId);
    } else if (entityType === 'comment') {
      await sc.from('posts_comments').update({ original_language: lang }).eq('id', entityId);
    } else if (entityType === 'event') {
      await sc.from('events').update({ original_language: lang }).eq('id', entityId);
    } else if (entityType === 'trip') {
      await sc.from('trips').update({ original_language: lang }).eq('id', entityId);
    } else if (entityType === 'bio') {
      // Store in the dedicated bio_original_language column — never touch
      // default_language, which is the user's own preference setting.
      await sc.from('profiles').update({ bio_original_language: lang } as any).eq('id', entityId);
    }
  } catch (e) {
    const code = e instanceof Error ? e.message : 'detect_error';
    logger?.warn({ entityType, entityId, err: code }, 'content_language_detect_failed');
  }
}

// ── On-demand translation ─────────────────────────────────────────────────────

/**
 * Translate the given fields from sourceLanguage → targetLanguage, with a
 * content_translations cache.  Returns the translated result or a failed/
 * skipped sentinel.  Never throws.
 */
export async function translateContentFields(
  sc: SupabaseClient,
  input: {
    entityType: ContentEntityType;
    entityId: string;
    fields: TranslatedFields;       // raw (original) field values
    sourceLanguage: string;
    targetLanguage: string;
    logger?: Logger;
  },
): Promise<ContentTranslationResult> {
  const { entityType, entityId, fields, sourceLanguage, targetLanguage, logger } = input;

  const skipped: ContentTranslationResult = {
    entityType, entityId, sourceLanguage, targetLanguage,
    translatedFields: {},
    translationLabel: '',
    status: 'skipped',
  };

  if (!TRANSLATION_ENABLED) return skipped;
  if (sourceLanguage === targetLanguage) return skipped;

  // 1. Cache hit?
  const { data: cached } = await sc
    .from('content_translations')
    .select('translated_fields, status, source_language')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .eq('target_language', targetLanguage)
    .maybeSingle();

  if (cached && (cached as any).status === 'translated') {
    const tf = (cached as any).translated_fields as TranslatedFields ?? {};
    return {
      entityType, entityId,
      sourceLanguage: (cached as any).source_language ?? sourceLanguage,
      targetLanguage,
      translatedFields: tf,
      translationLabel: `Translated from ${languageDisplayName(sourceLanguage)}`,
      status: 'translated',
    };
  }

  // 2. Translate each non-empty field.
  const translated: TranslatedFields = {};
  let anyFailed = false;
  const fieldEntries = Object.entries(fields) as [keyof TranslatedFields, string][];

  for (const [fieldName, originalText] of fieldEntries) {
    if (!originalText?.trim()) continue;
    try {
      const result = await translateWithRetry(originalText, sourceLanguage, targetLanguage);
      const validation = validateTranslation(originalText, result.translatedText, targetLanguage);
      if (!validation.valid) {
        logger?.warn(
          { entityType, entityId, field: fieldName, reason: validation.reason },
          'content_translation_validation_failed',
        );
        anyFailed = true;
        continue;
      }
      translated[fieldName] = result.translatedText;
    } catch (e) {
      const code = e instanceof Error ? (e.message.length < 80 ? e.message : 'translate_error') : 'unknown';
      logger?.warn({ entityType, entityId, field: fieldName, err: code }, 'content_translation_field_failed');
      anyFailed = true;
    }
  }

  const hasTranslation = Object.keys(translated).length > 0;
  const finalStatus = hasTranslation ? 'translated' : 'failed';

  // 3. Cache the result (upsert).
  await sc
    .from('content_translations')
    .upsert(
      {
        entity_type:       entityType,
        entity_id:         entityId,
        source_language:   sourceLanguage,
        target_language:   targetLanguage,
        translated_fields: translated,
        status:            finalStatus,
        error_message:     anyFailed && !hasTranslation ? 'all_fields_failed' : null,
        updated_at:        new Date().toISOString(),
      },
      { onConflict: 'entity_type,entity_id,target_language' },
    );

  if (!hasTranslation) {
    return { entityType, entityId, sourceLanguage, targetLanguage, translatedFields: {}, translationLabel: '', status: 'failed' };
  }

  return {
    entityType, entityId, sourceLanguage, targetLanguage,
    translatedFields: translated,
    translationLabel: `Translated from ${languageDisplayName(sourceLanguage)}`,
    status: 'translated',
  };
}

/**
 * Invalidate cached translations for an entity (call when content is edited).
 * Fire-and-forget safe.
 */
export async function invalidateContentTranslations(
  sc: SupabaseClient,
  entityType: ContentEntityType,
  entityId: string,
): Promise<void> {
  await sc
    .from('content_translations')
    .delete()
    .eq('entity_type', entityType)
    .eq('entity_id', entityId);
}
