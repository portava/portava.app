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
import { publishToUsers } from '../lib/telegraphEvents';

// ── Types shared with routes ───────────────────────────────────────────────────

export type TranslationStatusValue = 'pending' | 'translated' | 'failed' | 'skipped';

/**
 * What `messages.language_detection_source` is allowed to claim.
 *
 * This column is a DURABLE, QUERYABLE ASSERTION about how the message's
 * language was decided, so each value has to be something we actually know:
 *
 *   'provider'                      the provider read the text and named a language.
 *   'sender_preference'             the sender's profile was read and it carried a
 *                                   stated language, which we then used.
 *   'default'                       the sender's profile was READ SUCCESSFULLY and
 *                                   stated no language (no row, or both columns
 *                                   null/blank), so the server's default was used.
 *   'sender_preference_unreadable'  the sender's profile COULD NOT BE READ. We do
 *                                   not know whether a preference exists. The
 *                                   server's default was used as a placeholder and
 *                                   this value says so.
 *
 * WHY THE FOURTH VALUE EXISTS, rather than folding a failed read into 'default'.
 * This tree's rule, applied in `LayoverPrivacyGuard` (`preferences_unreadable`),
 * `LayoverReplanService` (`plan_unreadable`), `SafeReturnNotificationService`
 * (`trip_unreadable`) and `highlightResurfacing` (`state: 'unreadable'`), is that
 * AN UNREADABLE X IS NOT AN EMPTY X. 'default' is a positive statement — "we
 * looked, and the sender has stated nothing" — and a `profiles` outage is not
 * entitled to make it. The naming follows the same house convention
 * (`<thing>_unreadable`) so the value reads the same way as its siblings.
 *
 * NO MIGRATION IS NEEDED and none was written: `language_detection_source` is a
 * plain nullable `text` column with no CHECK constraint in `migrations/` or in
 * `baseline/20260819_baseline_structure.sql`. `migrations/0009_translation.sql`
 * carries a trailing COMMENT listing the original three values; it is not a
 * constraint and applied migrations are checksummed against the live ledger, so
 * it is deliberately left alone. THIS type is the vocabulary of record.
 */
export type LanguageDetectionSource =
  | 'provider'
  | 'sender_preference'
  | 'default'
  | 'sender_preference_unreadable';

/**
 * The answer to "what language did the sender say they write in?", carrying the
 * third state that a bare `string` cannot.
 *
 * `preferredLanguage: null` means NO LANGUAGE IS KNOWN, and `unreadable` says
 * which kind of not-known it is. Keeping them as two fields rather than one
 * sentinel string is deliberate: the language is consumed as a language and the
 * provenance is consumed as provenance, and a caller that only needs one of them
 * cannot accidentally spend the other.
 */
export interface SenderLanguagePreference {
  /** The language the sender actually stated, or null if none is known. */
  readonly preferredLanguage: string | null;
  /** True ONLY when the read failed — "we do not know", never "they stated nothing". */
  readonly unreadable: boolean;
}

/**
 * senderLanguageFrom — the single interpreter of the sender-preference read.
 *
 * WHAT THIS REPLACES, at five call sites in `routes/messaging.ts` and
 * `routes/groupChat.ts`:
 *
 *     const { data: senderProfile } = await sc.from('profiles')…
 *     const senderLanguage = (senderProfile as any)?.preferred_language
 *       ?? (senderProfile as any)?.preferred_message_language ?? 'en';
 *
 * supabase-js RESOLVES on a database error, so `data` was null and `error` was
 * never bound: a sender who chose English, a sender who chose nothing, and a
 * `profiles` read that FAILED all became the identical string `'en'`. The
 * pipeline then wrote `language_detection_source: 'sender_preference'` for all
 * three, which is a durable false claim in two of them. It lives here, next to
 * the vocabulary it feeds, because five copies of a coalesce is how the same
 * defect came to exist in five places.
 *
 * `error` is typed `unknown` on purpose — callers pass a PostgrestError and the
 * only thing this needs from it is whether it is there.
 */
export function senderLanguageFrom(
  row: { preferred_language?: string | null; preferred_message_language?: string | null } | null | undefined,
  error: unknown,
): SenderLanguagePreference {
  // The read failed. We know nothing, and saying nothing is the honest answer.
  if (error) return { preferredLanguage: null, unreadable: true };

  const stated =
    (row as any)?.preferred_language ?? (row as any)?.preferred_message_language ?? null;

  // A blank string is a column that was written but says nothing; it is a
  // preference in the schema's eyes and not one in the user's. Treated as
  // "stated nothing" rather than passed on as a language code, which is what
  // the old `?? 'en'` chain did (`'' ?? 'en'` is `''`).
  const language = typeof stated === 'string' && stated.trim() !== '' ? stated : null;
  return { preferredLanguage: language, unreadable: false };
}

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

/**
 * The language a message is stamped with when nothing better is known.
 *
 * Named rather than inlined because it is used in two arms that mean DIFFERENT
 * things ('default' and 'sender_preference_unreadable') and reading the same
 * literal in both is what made them look interchangeable in the first place.
 */
const DEFAULT_SOURCE_LANGUAGE = 'en';

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
  /**
   * The language the sender STATED, used as a fallback if provider detection
   * fails. `null` (or omitted) means no language is known — either because the
   * sender stated none or because the read failed, and
   * `senderPreferenceUnreadable` is what tells those two apart.
   */
  senderPreferredLanguage?: string | null;
  /**
   * True ONLY when the sender-preference read FAILED. Callers get this from
   * `senderLanguageFrom(data, error)`; omitting it means "the read succeeded",
   * which is the safe default for the one caller that has no read to report.
   */
  senderPreferenceUnreadable?: boolean;
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
  const {
    messageId,
    body,
    senderId,
    threadId,
    senderPreferredLanguage,
    senderPreferenceUnreadable,
    logger,
  } = input;

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
    //
    // The message is translated and stamped with an `original_language` in
    // every branch — what differs is only the CLAIM about where that language
    // came from, which is the whole point of `language_detection_source`.
    //
    // THE ARMS BELOW USED TO BE TWO, AND ONE OF THOSE TWO WAS UNREACHABLE.
    // The fallback read `senderPreferredLanguage ?? 'en'` and then
    // `senderPreferredLanguage ? 'sender_preference' : 'default'`, and every
    // caller pre-coalesced its profile read to `'en'`, so the ternary was
    // handed a truthy string no matter what had happened upstream: 'default'
    // could only fire on a stored EMPTY-STRING preference, which no writer in
    // this tree produces. The effect was that a `profiles` outage minted a row
    // asserting the sender had chosen English. Now the caller passes null plus
    // a flag, so all three arms are reachable and each says a true thing.
    let sourceLanguage: string;
    let detectionSource: LanguageDetectionSource;
    try {
      sourceLanguage = await detectWithRetry(body, 1);
      detectionSource = 'provider';
    } catch {
      if (senderPreferredLanguage) {
        sourceLanguage = senderPreferredLanguage;
        detectionSource = 'sender_preference';
      } else if (senderPreferenceUnreadable) {
        // No language, and we do not even know whether one exists.
        sourceLanguage = DEFAULT_SOURCE_LANGUAGE;
        detectionSource = 'sender_preference_unreadable';
        logger?.warn(
          { messageId, senderId },
          'sender language preference unreadable — stamping a placeholder language, not a stated one',
        );
      } else {
        // A successful read that found no preference. This is the honest
        // 'default': we looked, and the sender has stated nothing.
        sourceLanguage = DEFAULT_SOURCE_LANGUAGE;
        detectionSource = 'default';
      }
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
        const validation = validateTranslation(body, result.translatedText, targetLanguage);
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
        // Realtime: the translated text can now swap in live for this recipient.
        publishToUsers([recipientId], {
          type: 'message.translated',
          threadId,
          payload: { messageId, status: 'translated' },
        });
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

// ── Retranslate on language-preference change ─────────────────────────────────

const RETRANSLATE_BATCH_LIMIT = 200;

/**
 * retranslateForUser — fire-and-forget sweep triggered when a user changes
 * their preferred translation language.
 *
 * Fetches the user's most-recent message_translations rows (as recipient),
 * then re-translates each one to the new target language.  Only this user's
 * rows are touched; other recipients are unaffected.  Never throws.
 */
export async function retranslateForUser(
  sc: SupabaseClient,
  userId: string,
  newTargetLanguage: string,
  logger?: Logger,
): Promise<void> {
  if (!TRANSLATION_ENABLED) return;

  try {
    // Fetch the most recent translation rows for this recipient.
    const { data: rows, error: fetchErr } = await sc
      .from('message_translations')
      .select('message_id, source_language')
      .eq('recipient_id', userId)
      .order('updated_at', { ascending: false })
      .limit(RETRANSLATE_BATCH_LIMIT);

    if (fetchErr) {
      logger?.warn({ err: fetchErr.message, userId }, 'retranslate_fetch_failed');
      return;
    }
    if (!rows || rows.length === 0) return;

    const messageIds = rows.map((r: any) => r.message_id as string);

    // Fetch message bodies for these rows.
    const { data: messages, error: msgErr } = await sc
      .from('messages')
      .select('id, body, original_language')
      .in('id', messageIds);

    if (msgErr) {
      logger?.warn({ err: msgErr.message, userId }, 'retranslate_messages_fetch_failed');
      return;
    }

    const msgMap: Record<string, { body: string; originalLanguage: string | null }> = {};
    for (const m of messages ?? []) {
      msgMap[(m as any).id] = {
        body: (m as any).body as string,
        originalLanguage: (m as any).original_language as string | null,
      };
    }

    // Build a source-language map from the translation rows for fallback.
    const srcMap: Record<string, string> = {};
    for (const r of rows) {
      srcMap[(r as any).message_id] = (r as any).source_language as string;
    }

    for (const messageId of messageIds) {
      const msg = msgMap[messageId];
      if (!msg || !msg.body) continue;

      const sourceLanguage = msg.originalLanguage ?? srcMap[messageId] ?? 'en';

      // Same language as target — mark skipped.
      if (sourceLanguage === newTargetLanguage) {
        await upsertTranslation(sc, {
          messageId,
          recipientId: userId,
          sourceLanguage,
          targetLanguage: newTargetLanguage,
          translatedBody: null,
          provider: null,
          status: 'skipped',
          errorMessage: null,
        });
        continue;
      }

      try {
        const result = await translateWithRetry(msg.body, sourceLanguage, newTargetLanguage, 1);
        const validation = validateTranslation(msg.body, result.translatedText, newTargetLanguage);
        if (!validation.valid) {
          await upsertTranslation(sc, {
            messageId,
            recipientId: userId,
            sourceLanguage,
            targetLanguage: newTargetLanguage,
            translatedBody: null,
            provider: result.provider,
            status: 'failed',
            errorMessage: `validation_${validation.reason ?? 'unknown'}`,
          });
          continue;
        }
        await upsertTranslation(sc, {
          messageId,
          recipientId: userId,
          sourceLanguage,
          targetLanguage: newTargetLanguage,
          translatedBody: result.translatedText,
          provider: result.provider,
          status: 'translated',
          errorMessage: null,
        });
      } catch (e: unknown) {
        const errCode = e instanceof Error ? (e.message.length < 80 ? e.message : 'translation_error') : 'unknown';
        await upsertTranslation(sc, {
          messageId,
          recipientId: userId,
          sourceLanguage,
          targetLanguage: newTargetLanguage,
          translatedBody: null,
          provider: null,
          status: 'failed',
          errorMessage: errCode,
        });
        logger?.warn({ messageId, userId, target: newTargetLanguage, err: errCode }, 'retranslate_item_failed');
      }
    }

    logger?.info({ userId, target: newTargetLanguage, count: messageIds.length }, 'retranslate_sweep_complete');
  } catch (e: unknown) {
    const code = e instanceof Error ? e.message : 'retranslate_error';
    logger?.error({ userId, err: code }, 'retranslate_sweep_error');
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
