/**
 * MessageTranslationService
 *
 * Runs after a message is saved. For each recipient in the thread:
 *   (a) Detects source language (provider first, then sender preference fallback).
 *   (b) Looks up recipient's preferred_message_language.
 *   (c) Skips if languages match (status: skipped).
 *   (d) Calls provider with timeout + max 2 retries.
 *   (e) Writes / updates a message_translations row.
 *   (f) Falls back to status: failed on any error — never throws.
 *
 * Privacy: never logs full message body. Only message_id, status, codes.
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

// ── Types shared with routes ───────────────────────────────────────────────────

export type TranslationStatusValue = 'pending' | 'translated' | 'failed' | 'skipped';

export interface TranslationDisplayFields {
  displayBody: string | null;
  originalBody: string | null;
  originalLanguage: string | null;
  translated: boolean;
  translationStatus: TranslationStatusValue | null;
  translationLabel: string | null;   // e.g. "Translated from Spanish"
  canShowOriginal: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('translation_timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function detectWithRetry(
  text: string,
  maxRetries: number,
): Promise<string> {
  const provider = getTranslationProvider();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await withTimeout(provider.detectLanguage(text), TRANSLATION_TIMEOUT_MS);
      return result.language;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function translateWithRetry(
  text: string,
  source: string,
  target: string,
  maxRetries: number,
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

// ── Main pipeline ─────────────────────────────────────────────────────────────

export interface TranslationPipelineInput {
  messageId: string;
  body: string;
  senderId: string;
  threadId: string;
  /** Sender's preferred language (used as fallback if detection fails). */
  senderPreferredLanguage?: string;
  logger?: Logger;
}

/**
 * translateMessageForThread
 *
 * Call this after a message row is inserted. Never throws — all errors are
 * caught and written as status: 'failed' rows. Returns resolved promise always.
 */
export async function translateMessageForThread(
  sc: SupabaseClient,
  input: TranslationPipelineInput,
): Promise<void> {
  const { messageId, body, senderId, threadId, senderPreferredLanguage, logger } = input;

  if (!TRANSLATION_ENABLED) return;

  try {
    // 1. Get all thread members (other than the sender).
    const { data: members } = await sc
      .from('message_thread_members')
      .select('user_id')
      .eq('thread_id', threadId)
      .neq('user_id', senderId);

    const recipientIds: string[] = (members ?? []).map((m: any) => m.user_id);
    if (recipientIds.length === 0) return;

    // 2. Detect source language (provider, with fallback to sender preference).
    let sourceLanguage: string;
    let detectionSource: 'provider' | 'sender_preference' | 'default';
    try {
      sourceLanguage = await detectWithRetry(body, 1);
      detectionSource = 'provider';
    } catch {
      sourceLanguage = senderPreferredLanguage ?? 'en';
      detectionSource = senderPreferredLanguage ? 'sender_preference' : 'default';
    }

    // Update the message with detected language.
    await sc
      .from('messages')
      .update({ original_language: sourceLanguage, language_detection_source: detectionSource })
      .eq('id', messageId);

    // 3. Fetch recipient language preferences.
    // preferred_language (user-chosen in Settings) takes priority over
    // preferred_message_language (legacy auto-translate field).
    const { data: profiles } = await sc
      .from('profiles')
      .select('id, preferred_language, preferred_message_language, auto_translate_messages')
      .in('id', recipientIds);

    const profileMap: Record<string, { preferredLanguage: string; autoTranslate: boolean }> = {};
    for (const p of profiles ?? []) {
      const explicitLang = (p as any).preferred_language as string | null;
      const legacyLang = (p as any).preferred_message_language as string | null;
      profileMap[(p as any).id] = {
        preferredLanguage: explicitLang ?? legacyLang ?? 'en',
        autoTranslate: (p as any).auto_translate_messages ?? true,
      };
    }

    // 4. Process each recipient.
    for (const recipientId of recipientIds) {
      const prefs = profileMap[recipientId] ?? { preferredLanguage: 'en', autoTranslate: true };
      const targetLanguage = prefs.preferredLanguage;

      // a. Skip if auto-translate disabled.
      if (!prefs.autoTranslate) {
        await upsertTranslation(sc, {
          messageId,
          recipientId,
          sourceLanguage,
          targetLanguage,
          translatedBody: null,
          provider: null,
          status: 'skipped',
          errorMessage: 'auto_translate_disabled',
        });
        continue;
      }

      // b. Skip if same language.
      if (sourceLanguage === targetLanguage) {
        await upsertTranslation(sc, {
          messageId,
          recipientId,
          sourceLanguage,
          targetLanguage,
          translatedBody: null,
          provider: null,
          status: 'skipped',
          errorMessage: null,
        });
        continue;
      }

      // c. Translate.
      try {
        const result = await translateWithRetry(body, sourceLanguage, targetLanguage, 1);

        // Validate the translation before storing it.
        const validation = validateTranslation(body, result.translatedText);
        if (!validation.valid) {
          await upsertTranslation(sc, {
            messageId,
            recipientId,
            sourceLanguage,
            targetLanguage,
            translatedBody: null,
            provider: result.provider,
            status: 'failed',
            errorMessage: `validation_${validation.reason ?? 'unknown'}`,
          });
          logger?.warn(
            {
              messageId,
              recipientId,
              source: sourceLanguage,
              target: targetLanguage,
              provider: result.provider,
              reason: validation.reason,
            },
            'translation_validation_failed',
          );
          continue;
        }

        await upsertTranslation(sc, {
          messageId,
          recipientId,
          sourceLanguage,
          targetLanguage,
          translatedBody: result.translatedText,
          provider: result.provider,
          status: 'translated',
          errorMessage: null,
        });
        logger?.info(
          { messageId, recipientId, source: sourceLanguage, target: targetLanguage, provider: result.provider },
          'translation_ok',
        );
      } catch (e: unknown) {
        const errCode =
          e instanceof Error ? (e.message.length < 80 ? e.message : 'translation_error') : 'unknown';
        await upsertTranslation(sc, {
          messageId,
          recipientId,
          sourceLanguage,
          targetLanguage,
          translatedBody: null,
          provider: null,
          status: 'failed',
          errorMessage: errCode,
        });
        logger?.warn(
          { messageId, recipientId, source: sourceLanguage, target: targetLanguage, err: errCode },
          'translation_failed',
        );
      }
    }
  } catch (e: unknown) {
    // Outer catch — pipeline error must not surface to caller.
    const code = e instanceof Error ? e.message : 'pipeline_error';
    logger?.error({ messageId, err: code }, 'translation_pipeline_error');
  }
}

// ── Invalidate (on edit) ──────────────────────────────────────────────────────

/**
 * markTranslationsPending — called when a message is edited.
 * Sets all existing message_translations rows for this message to 'pending'
 * so the pipeline regenerates them.
 */
export async function markTranslationsPending(
  sc: SupabaseClient,
  messageId: string,
): Promise<void> {
  await sc
    .from('message_translations')
    .update({ status: 'pending', translated_body: null, error_message: null })
    .eq('message_id', messageId);
}

// ── Display field builder (for GET /messages) ─────────────────────────────────

/**
 * Build per-message display fields for the requesting user (as recipient).
 * `myUserId` is the current authenticated user.
 * `translationRow` is their message_translations row (or null).
 */
export function buildDisplayFields(
  msg: {
    body: string | null;
    deleted: boolean;
    senderId: string;
    originalLanguage?: string | null;
  },
  myUserId: string,
  translationRow: {
    source_language: string;
    target_language: string;
    translated_body: string | null;
    status: TranslationStatusValue;
  } | null,
): TranslationDisplayFields {
  // Deleted messages: no body, no translation.
  if (msg.deleted || msg.body === null) {
    return {
      displayBody: null,
      originalBody: null,
      originalLanguage: null,
      translated: false,
      translationStatus: null,
      translationLabel: null,
      canShowOriginal: false,
    };
  }

  // Sender sees their own message — always original, no label.
  if (msg.senderId === myUserId) {
    return {
      displayBody: msg.body,
      originalBody: msg.body,
      originalLanguage: msg.originalLanguage ?? null,
      translated: false,
      translationStatus: null,
      translationLabel: null,
      canShowOriginal: false,
    };
  }

  // No translation row (same language or pipeline not run yet).
  if (!translationRow) {
    return {
      displayBody: msg.body,
      originalBody: msg.body,
      originalLanguage: msg.originalLanguage ?? null,
      translated: false,
      translationStatus: null,
      translationLabel: null,
      canShowOriginal: false,
    };
  }

  const { status, translated_body, source_language } = translationRow;

  if (status === 'skipped') {
    return {
      displayBody: msg.body,
      originalBody: msg.body,
      originalLanguage: source_language,
      translated: false,
      translationStatus: 'skipped',
      translationLabel: null,
      canShowOriginal: false,
    };
  }

  if (status === 'pending') {
    return {
      displayBody: msg.body,
      originalBody: msg.body,
      originalLanguage: source_language,
      translated: false,
      translationStatus: 'pending',
      translationLabel: null,
      canShowOriginal: false,
    };
  }

  if (status === 'failed') {
    // Silent fallback: show original text with no label or error banner.
    return {
      displayBody: msg.body,
      originalBody: msg.body,
      originalLanguage: source_language,
      translated: false,
      translationStatus: 'failed',
      translationLabel: null,
      canShowOriginal: false,
    };
  }

  // status === 'translated'
  // Guard against an identical translation slipping through (no-op).
  const translatedText = translated_body ?? null;
  if (!translatedText || translatedText.trim() === msg.body.trim()) {
    return {
      displayBody: msg.body,
      originalBody: msg.body,
      originalLanguage: source_language,
      translated: false,
      translationStatus: 'translated',
      translationLabel: null,
      canShowOriginal: false,
    };
  }

  const sourceName = languageDisplayName(source_language);
  return {
    displayBody: translatedText,
    originalBody: msg.body,
    originalLanguage: source_language,
    translated: true,
    translationStatus: 'translated',
    translationLabel: `Translated from ${sourceName}`,
    canShowOriginal: true,
  };
}

// ── Upsert helper ─────────────────────────────────────────────────────────────

async function upsertTranslation(
  sc: SupabaseClient,
  row: {
    messageId: string;
    recipientId: string;
    sourceLanguage: string;
    targetLanguage: string;
    translatedBody: string | null;
    provider: string | null;
    status: TranslationStatusValue;
    errorMessage: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await sc.from('message_translations').upsert(
    {
      message_id: row.messageId,
      recipient_id: row.recipientId,
      source_language: row.sourceLanguage,
      target_language: row.targetLanguage,
      translated_body: row.translatedBody,
      provider: row.provider,
      status: row.status,
      error_message: row.errorMessage,
      updated_at: now,
    },
    { onConflict: 'message_id,recipient_id' },
  );
}
