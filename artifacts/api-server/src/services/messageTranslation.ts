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
import type { TranslateTextResult } from '../lib/translation';
import {
  getTranslationProvider,
  TRANSLATION_ENABLED,
  TRANSLATION_TIMEOUT_MS,
  languageDisplayName,
  validateTranslation,
  translatePreservingEntities,
} from '../lib/translation';
import { publishToUsers } from '../lib/telegraphEvents';
import { isBlockedBetween } from '../lib/blockGuard.js';
import { messageKernelEnabled, applyLifecycleExclusion } from './telegraphMessageKernel.js';
// The envelope version literal only — NOT the kind registry. See
// `isStructuredEnvelopeBody` for why the guard is invariant-based rather than
// kind-based.
import { KIND_ENVELOPE_VERSION } from './telegraph/messageKinds.js';
import { historyBoundEnabled, visibleFromOf, withinWindow } from './groupChatHistoryBound.js';

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

export type TranslationConfidence = 'high' | 'low';

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
  translationConfidence: TranslationConfidence | null;
  showOriginalAlongside: boolean;
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

/**
 * The language code written when NO language is known — ISO 639-2's `und`,
 * "undetermined".
 *
 * Distinct from DEFAULT_SOURCE_LANGUAGE above, and the distinction is the whole
 * point: `'en'` is a guess that a reader cannot tell from a stated preference,
 * whereas `und` says on its face that nothing was established. `routes/messaging.ts`
 * already writes exactly this code when a per-viewer translation read fails, so
 * this is the tree's convention rather than a new one.
 */
const UNKNOWN_LANGUAGE = 'und';

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('translation_timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class TranslationSourceUnavailable extends Error {
  constructor() { super('translation_source_unavailable'); }
}

async function detectWithRetry(
  text: string,
  maxRetries: number,
  beforeDispatch: () => Promise<boolean>,
): Promise<string> {
  const provider = getTranslationProvider();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!await beforeDispatch()) throw new TranslationSourceUnavailable();
    try {
      const result = await withTimeout(provider.detectLanguage(text), TRANSLATION_TIMEOUT_MS);
      if (!await beforeDispatch()) throw new TranslationSourceUnavailable();
      return result.language;
    } catch (error) {
      if (error instanceof TranslationSourceUnavailable) throw error;
      lastErr = error;
    }
  }
  throw lastErr;
}

async function translateWithRetry(
  text: string,
  source: string,
  target: string,
  maxRetries: number,
  beforeRetry?: () => Promise<boolean>,
): Promise<TranslateTextResult> {
  const prov = getTranslationProvider();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && beforeRetry && !await beforeRetry()) throw new Error('retranslate_source_unavailable');
    try {
      return await withTimeout(translatePreservingEntities(prov, text, source, target, beforeRetry), TRANSLATION_TIMEOUT_MS);
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
 * Is this `messages.body` a §6.2 STRUCTURED ENVELOPE rather than prose?
 *
 * ── WHY THE TRANSLATION PIPELINE OF ALL PLACES HAS TO ASK ───────────────────
 * A §6.2 typed message stores JSON in `body`, and for VOICE that JSON contains
 * `payload.url` — a `post-media/<path>` storage key for a PRIVATE bucket. This
 * service takes a bare `body: string` and knows nothing about message kinds, so
 * if any send path ever hands it a typed message it would (a) post a private
 * storage key to a third-party translation provider and (b) store that key in
 * `message_translations.translated_body`, a column `lib/mediaAccess.ts`'s media
 * gate does not cover and which every thread reader receives.
 *
 * No route wires a typed or voice send to this pipeline today. That makes the
 * hazard LATENT, not absent, and a latent hazard one import away from a privacy
 * incident is worth a guard rather than a comment — §18.2 T243's "audio is
 * authoritative" means, at minimum, that nothing manufactures a derivative from
 * a voice note behind its back.
 *
 * ── WHY IT DOES NOT ASK THE KIND REGISTRY ───────────────────────────────────
 * `parseKindEnvelope` needs a `msg_type`, which this service is never given,
 * and enumerating kinds here would mean a kind added later is translated by
 * default — the wrong direction for a guard. The two envelope INVARIANTS are
 * enough and are stable across kinds: a string `kind` and the envelope version.
 * A new kind is covered the day it is written.
 *
 * Deliberately strict about what counts. Prose that merely CONTAINS the words
 * is not JSON and parses to nothing; a bare array, `null`, and an object
 * missing either field are all prose as far as this is concerned, so an
 * ordinary message can never be silently dropped from translation by a quirk of
 * its text.
 */
export function isStructuredEnvelopeBody(body: string | null | undefined): boolean {
  if (typeof body !== 'string' || body.length === 0) return false;
  const first = body.trimStart()[0];
  if (first !== '{') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const o = parsed as Record<string, unknown>;
  return typeof o['kind'] === 'string' && o['envelopeVersion'] === KIND_ENVELOPE_VERSION;
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

  // §18.2 T243 — A STRUCTURED ENVELOPE IS NOT PROSE, AND IS NOT TRANSLATED.
  //
  // FIRST, before the roster read, before detection and before any provider
  // call, because the point of the guard is that the envelope's contents never
  // leave this process. A VOICE envelope carries a private `post-media` storage
  // key; the others carry coordinates, object ids and titles. None of them is
  // text a person wrote, so translating one would produce nonsense AND disclose
  // its innards — see `isStructuredEnvelopeBody`.
  //
  // It writes NO ROW. A `message_translations` row exists to say what happened
  // to a recipient's view of some prose; a typed message has no prose, and a
  // row keyed to one would be a claim about a translation that was never a
  // sensible thing to attempt. `buildDisplayFields` renders a message with no
  // row as its untouched original, which is exactly right for a voice note.
  if (isStructuredEnvelopeBody(body)) {
    logger?.info(
      { messageId, threadId },
      'structured envelope body — not translatable prose, no provider call and no row written',
    );
    return;
  }

  try {
    let expectedSource = await readTranslationSource(sc, messageId);
    if (!expectedSource || expectedSource.threadId !== threadId || expectedSource.senderId !== senderId
      || expectedSource.body !== body || typeof expectedSource.createdAt !== 'string'
      || (expectedSource.editedAt !== null && typeof expectedSource.editedAt !== 'string')) return;

    const { data: members, error: membersError } = await sc.from('message_thread_members')
      .select('user_id').eq('thread_id', threadId).neq('user_id', senderId);
    if (membersError || !Array.isArray(members)
      || members.some(member => !member || typeof member.user_id !== 'string' || !member.user_id)) {
      logger?.error({ messageId, threadId, err: 'translation_roster_unreadable' },
        'thread roster unreadable — no recipient can be translated for, and this is not a solo thread');
      return;
    }

    const recipients: Array<{
      recipientId: string;
      preference: RecipientTranslationPreference;
      isCurrent: () => Promise<boolean>;
    }> = [];
    for (const recipientId of new Set(members.map(member => member.user_id as string))) {
      const initial = await readTranslationRecipient(sc, recipientId, messageId);
      if (!initial || !sameTranslationSource(initial.source, expectedSource) || initial.preference.state === 'missing') continue;
      const preference = initial.preference;
      let retired = false;
      const isCurrent = async (): Promise<boolean> => {
        if (retired) return false;
        try {
          const current = await readTranslationRecipient(sc, recipientId, messageId);
          retired = !current || !sameTranslationSource(current.source, expectedSource!)
            || !sameTranslationPreference(current.preference, preference);
        } catch {
          retired = true;
        }
        return !retired;
      };
      recipients.push({ recipientId, preference, isCurrent });
    }
    if (recipients.length === 0) return;

    const anyCurrent = async (enabledOnly: boolean): Promise<boolean> => {
      for (const recipient of recipients) {
        if ((!enabledOnly || recipient.preference.state === 'enabled') && await recipient.isCurrent()) return true;
      }
      return false;
    };
    let sourceLanguage = senderPreferredLanguage || DEFAULT_SOURCE_LANGUAGE;
    let detectionSource: LanguageDetectionSource = senderPreferredLanguage ? 'sender_preference'
      : senderPreferenceUnreadable ? 'sender_preference_unreadable' : 'default';
    if (recipients.some(recipient => recipient.preference.state === 'enabled')) {
      try {
        sourceLanguage = await detectWithRetry(body, 1, () => anyCurrent(true));
        detectionSource = 'provider';
      } catch (error) {
        if (error instanceof TranslationSourceUnavailable) return;
        if (!await anyCurrent(true)) return;
      }
    } else if (expectedSource.originalLanguage && expectedSource.detectionSource) {
      sourceLanguage = expectedSource.originalLanguage;
      detectionSource = expectedSource.detectionSource;
    }
    if (!await anyCurrent(false)) return;

    const stampedSource = Object.freeze({ ...expectedSource, originalLanguage: sourceLanguage, detectionSource });
    let stamp = applyLifecycleExclusion(sc.from('messages')
      .update({ original_language: sourceLanguage, language_detection_source: detectionSource })
      .eq('id', messageId).eq('thread_id', expectedSource.threadId).eq('sender_id', expectedSource.senderId)
      .eq('body', expectedSource.body).eq('created_at', expectedSource.createdAt)
      .is('deleted_at', null).is('ciphertext', null), expectedSource.kernel);
    stamp = expectedSource.editedAt === null ? stamp.is('edited_at', null) : stamp.eq('edited_at', expectedSource.editedAt);
    stamp = expectedSource.originalLanguage === null ? stamp.is('original_language', null)
      : stamp.eq('original_language', expectedSource.originalLanguage);
    stamp = expectedSource.detectionSource === null ? stamp.is('language_detection_source', null)
      : stamp.eq('language_detection_source', expectedSource.detectionSource);
    const { data: stamped, error: stampError } = await stamp
      .select('id, thread_id, sender_id, body, created_at, edited_at, original_language, language_detection_source').maybeSingle();
    if (stampError || !stamped || stamped.id !== messageId || stamped.thread_id !== stampedSource.threadId
      || stamped.sender_id !== stampedSource.senderId || stamped.body !== stampedSource.body
      || stamped.created_at !== stampedSource.createdAt || stamped.edited_at !== stampedSource.editedAt
      || stamped.original_language !== sourceLanguage || stamped.language_detection_source !== detectionSource) {
      logger?.warn({ messageId, err: 'translation_stamp_unavailable' }, 'translation_stamp_withheld');
      return;
    }
    expectedSource = stampedSource;

    for (const { recipientId, preference, isCurrent } of recipients) {
      if (!await isCurrent()) continue;
      const targetLanguage = preference.state === 'enabled' || preference.state === 'disabled'
        ? preference.targetLanguage : UNKNOWN_LANGUAGE;
      const write = (row: Parameters<typeof upsertTranslation>[1]) => upsertTranslation(sc, row, logger, isCurrent);
      const base = {
        messageId, recipientId, sourceLanguage, targetLanguage,
        translatedBody: null, provider: null, providerVersion: null, confidence: null,
      };
      if (preference.state === 'unreadable') {
        await write({ ...base, status: 'failed', errorMessage: 'recipient_preferences_unreadable' });
        continue;
      }
      if (preference.state === 'disabled') {
        await write({ ...base, status: 'skipped', errorMessage: 'auto_translate_disabled' });
        continue;
      }
      if (sourceLanguage === targetLanguage) {
        await write({
          ...base,
          sourceLanguage: detectionSource === 'provider' ? sourceLanguage : UNKNOWN_LANGUAGE,
          status: detectionSource === 'provider' ? 'skipped' : 'failed',
          errorMessage: detectionSource === 'provider' ? null : 'source_language_unverified',
        });
        continue;
      }
      try {
        const result = await translateWithRetry(body, sourceLanguage, targetLanguage, 1, isCurrent);
        if (!await isCurrent()) continue;
        const validation = validateTranslation(body, result.translatedText, targetLanguage);
        if (!validation.valid) {
          await write({ ...base, provider: result.provider, providerVersion: result.providerVersion,
            status: 'failed', errorMessage: `validation_${validation.reason ?? 'unknown'}` });
          logger?.warn({ messageId, recipientId, source: sourceLanguage, target: targetLanguage,
            provider: result.provider, reason: validation.reason }, 'translation_validation_failed');
          continue;
        }
        const outcome = await write({ ...base, translatedBody: result.translatedText, provider: result.provider,
          providerVersion: result.providerVersion, status: 'translated', errorMessage: null });
        if (outcome !== 'written' || !await isCurrent()) continue;
        logger?.info({ messageId, recipientId, source: sourceLanguage, target: targetLanguage,
          provider: result.provider, providerVersion: result.providerVersion, confidence: null }, 'translation_ok');
        publishToUsers([recipientId], {
          type: 'message.translated', threadId, payload: { messageId, status: 'translated' },
        });
      } catch (error: unknown) {
        const errCode = error instanceof Error ? (error.message.length < 80 ? error.message : 'translation_error') : 'unknown';
        await write({ ...base, status: 'failed', errorMessage: errCode });
        logger?.warn({ messageId, recipientId, source: sourceLanguage, target: targetLanguage, err: errCode }, 'translation_failed');
      }
    }
  } catch (error: unknown) {
    logger?.error({ messageId, err: error instanceof Error ? error.message : 'pipeline_error' }, 'translation_pipeline_error');
  }
}

// ── Retranslate on language-preference change ─────────────────────────────────

const RETRANSLATE_BATCH_LIMIT = 200;

interface RetranslationSource {
  readonly threadId: string;
  readonly senderId: string;
  readonly body: string;
  readonly createdAt: string | null | undefined;
  readonly editedAt: string | null;
  readonly originalLanguage: string | null;
  readonly detectionSource: LanguageDetectionSource | null;
  readonly kernel: boolean;
}

type RecipientTranslationPreference =
  | { readonly state: 'enabled' | 'disabled'; readonly targetLanguage: string }
  | { readonly state: 'unreadable' | 'missing' };

function sameTranslationSource(current: RetranslationSource, expected: RetranslationSource): boolean {
  return current.threadId === expected.threadId && current.senderId === expected.senderId
    && current.body === expected.body && current.createdAt === expected.createdAt && current.editedAt === expected.editedAt
    && current.originalLanguage === expected.originalLanguage && current.detectionSource === expected.detectionSource;
}

function sameTranslationPreference(current: RecipientTranslationPreference, expected: RecipientTranslationPreference): boolean {
  return current.state === expected.state && (!('targetLanguage' in expected)
    || ('targetLanguage' in current && current.targetLanguage === expected.targetLanguage));
}

async function readTranslationSource(sc: SupabaseClient, messageId: string): Promise<RetranslationSource | null> {
  const kernel = await messageKernelEnabled(sc);
  const { data: rawMessage, error } = await applyLifecycleExclusion(sc.from('messages')
    .select(kernel
      ? 'id, thread_id, sender_id, body, created_at, edited_at, deleted_at, ciphertext, original_language, language_detection_source, unsent_at'
      : 'id, thread_id, sender_id, body, created_at, edited_at, deleted_at, ciphertext, original_language, language_detection_source')
    .eq('id', messageId).is('deleted_at', null), kernel).maybeSingle();
  if (error) throw new Error('retranslate_messages_fetch_failed');
  const message = rawMessage as unknown as {
    id: string; thread_id: string; sender_id: string | null; body: string | null;
    created_at?: string | null; edited_at?: string | null; deleted_at: string | null;
    ciphertext: string | null; unsent_at?: string | null;
    original_language?: string | null; language_detection_source?: string | null;
  } | null;
  if (!message || message.id !== messageId || typeof message.thread_id !== 'string' || !message.thread_id
    || message.deleted_at !== null || message.ciphertext != null
    || (kernel && (!('unsent_at' in message) || message.unsent_at !== null))
    || typeof message.sender_id !== 'string' || !message.sender_id
    || typeof message.body !== 'string' || !message.body || isStructuredEnvelopeBody(message.body)
    || (message.created_at != null && typeof message.created_at !== 'string')
    || (message.edited_at != null && typeof message.edited_at !== 'string')
    || (message.original_language != null && typeof message.original_language !== 'string')
    || (message.language_detection_source != null && typeof message.language_detection_source !== 'string')) return null;
  return Object.freeze({
    threadId: message.thread_id,
    senderId: message.sender_id,
    body: message.body,
    createdAt: message.created_at,
    editedAt: message.edited_at ?? null,
    originalLanguage: message.original_language ?? null,
    detectionSource: (message.language_detection_source ?? null) as LanguageDetectionSource | null,
    kernel,
  });
}

async function readTranslationRecipient(
  sc: SupabaseClient,
  userId: string,
  messageId: string,
): Promise<{ source: RetranslationSource; preference: RecipientTranslationPreference } | null> {
  const source = await readTranslationSource(sc, messageId);
  if (!source) return null;
  const boundOn = await historyBoundEnabled(sc);
  const membershipQuery = boundOn
    ? sc.from('message_thread_members').select('thread_id, user_id, left_at, visible_from_at')
    : sc.from('message_thread_members').select('thread_id, user_id, left_at');
  const { data: membership, error: membershipError } = await membershipQuery
    .eq('thread_id', source.threadId).eq('user_id', userId).maybeSingle();
  if (membershipError) throw new Error('retranslate_membership_fetch_failed');
  if (!membership || membership.thread_id !== source.threadId || membership.user_id !== userId
    || membership.left_at !== null) return null;
  const visibleFrom = 'visible_from_at' in membership ? membership.visible_from_at : undefined;
  if (boundOn && visibleFrom !== null && (typeof visibleFrom !== 'string' || !visibleFrom)) return null;
  if (!withinWindow(source.createdAt, visibleFromOf({
    visible_from_at: typeof visibleFrom === 'string' ? visibleFrom : null,
  }, boundOn), { senderId: source.senderId, viewerId: userId })) return null;

  const { data: thread, error: threadError } = await sc.from('message_threads')
    .select('id, is_e2ee').eq('id', source.threadId).maybeSingle();
  if (threadError) throw new Error('retranslate_thread_fetch_failed');
  if (!thread || thread.id !== source.threadId || thread.is_e2ee !== false) return null;
  if (await isBlockedBetween(sc, userId, source.senderId)) return null;

  let preference: RecipientTranslationPreference;
  try {
    const { data, error } = await sc.from('profiles')
      .select('id, preferred_language, preferred_message_language, auto_translate_messages')
      .eq('id', userId).maybeSingle();
    const target = data?.preferred_language ?? data?.preferred_message_language;
    if (error) preference = { state: 'unreadable' };
    else if (data === null) preference = { state: 'missing' };
    else if (data?.id !== userId || typeof data.auto_translate_messages !== 'boolean'
      || typeof target !== 'string' || !target.trim()) preference = { state: 'unreadable' };
    else preference = { state: data.auto_translate_messages ? 'enabled' : 'disabled', targetLanguage: target };
  } catch {
    preference = { state: 'unreadable' };
  }
  return { source, preference: Object.freeze(preference) };
}

async function readRetranslationSource(
  sc: SupabaseClient,
  userId: string,
  messageId: string,
  targetLanguage: string,
): Promise<RetranslationSource | null> {
  const current = await readTranslationRecipient(sc, userId, messageId);
  return current?.preference.state === 'enabled' && current.preference.targetLanguage === targetLanguage
    ? current.source : null;
}

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

    // Build a source-language map from the translation rows for fallback.
    const srcMap: Record<string, string> = {};
    for (const r of rows) {
      srcMap[(r as any).message_id] = (r as any).source_language as string;
    }

    for (const messageId of messageIds) {
      const msg = await readRetranslationSource(sc, userId, messageId, newTargetLanguage);
      if (!msg) continue;

      const sourceStillAuthorized = async (): Promise<boolean> => {
        const current = await readRetranslationSource(sc, userId, messageId, newTargetLanguage);
        return current !== null && current.threadId === msg.threadId && current.senderId === msg.senderId
          && current.body === msg.body && current.createdAt === msg.createdAt && current.editedAt === msg.editedAt
          && current.originalLanguage === msg.originalLanguage && current.detectionSource === msg.detectionSource;
      };
      const writeIfAuthorized = async (row: Parameters<typeof upsertTranslation>[1]): Promise<void> => {
        await upsertTranslation(sc, row, logger, sourceStillAuthorized);
      };

      const sourceLanguage = msg.originalLanguage ?? srcMap[messageId] ?? 'en';

      // Same language as target — mark skipped.
      if (sourceLanguage === newTargetLanguage) {
        await writeIfAuthorized({
          messageId,
          recipientId: userId,
          sourceLanguage: msg.detectionSource === 'provider' ? sourceLanguage : UNKNOWN_LANGUAGE,
          targetLanguage: newTargetLanguage,
          translatedBody: null,
          provider: null,
          providerVersion: null,
          confidence: null,
          status: msg.detectionSource === 'provider' ? 'skipped' : 'failed',
          errorMessage: msg.detectionSource === 'provider' ? null : 'source_language_unverified',
        });
        continue;
      }

      try {
        const result = await translateWithRetry(msg.body, sourceLanguage, newTargetLanguage, 1, sourceStillAuthorized);
        const validation = validateTranslation(msg.body, result.translatedText, newTargetLanguage);
        if (!validation.valid) {
          await writeIfAuthorized({
            messageId,
            recipientId: userId,
            sourceLanguage,
            targetLanguage: newTargetLanguage,
            translatedBody: null,
            provider: result.provider,
            providerVersion: result.providerVersion,
            confidence: null,
            status: 'failed',
            errorMessage: `validation_${validation.reason ?? 'unknown'}`,
          });
          continue;
        }
        await writeIfAuthorized({
          messageId,
          recipientId: userId,
          sourceLanguage,
          targetLanguage: newTargetLanguage,
          translatedBody: result.translatedText,
          provider: result.provider,
          providerVersion: result.providerVersion,
          confidence: null,
          status: 'translated',
          errorMessage: null,
        });
      } catch (e: unknown) {
        const errCode = e instanceof Error ? (e.message.length < 80 ? e.message : 'translation_error') : 'unknown';
        await writeIfAuthorized({
          messageId,
          recipientId: userId,
          sourceLanguage,
          targetLanguage: newTargetLanguage,
          translatedBody: null,
          provider: null,
          providerVersion: null,
          confidence: null,
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
    confidence?: TranslationConfidence | null;
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
      // Nothing is being translated in this arm, so there is no translation
      // whose certainty could be in question and nothing to show alongside.
      translationConfidence: null,
      showOriginalAlongside: false,
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
      // Nothing is being translated in this arm, so there is no translation
      // whose certainty could be in question and nothing to show alongside.
      translationConfidence: null,
      showOriginalAlongside: false,
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
      // Nothing is being translated in this arm, so there is no translation
      // whose certainty could be in question and nothing to show alongside.
      translationConfidence: null,
      showOriginalAlongside: false,
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
      // Nothing is being translated in this arm, so there is no translation
      // whose certainty could be in question and nothing to show alongside.
      translationConfidence: null,
      showOriginalAlongside: false,
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
      // Nothing is being translated in this arm, so there is no translation
      // whose certainty could be in question and nothing to show alongside.
      translationConfidence: null,
      showOriginalAlongside: false,
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
      // Nothing is being translated in this arm, so there is no translation
      // whose certainty could be in question and nothing to show alongside.
      translationConfidence: null,
      showOriginalAlongside: false,
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
      // Nothing is being translated in this arm, so there is no translation
      // whose certainty could be in question and nothing to show alongside.
      translationConfidence: null,
      showOriginalAlongside: false,
    };
  }

  const sourceName = languageDisplayName(source_language);
  return {
    displayBody: translatedText,
    originalBody: msg.body,
    originalLanguage: source_language,
    translated: true,
    translationStatus: 'translated',
    translationLabel: `Translated from ${sourceName} — quality unverified`,
    canShowOriginal: true,
    translationConfidence: null,
    showOriginalAlongside: true,
  };
}

// ── Upsert helper ─────────────────────────────────────────────────────────────

/**
 * Postgres raises `42703` (undefined_column) and PostgREST answers `PGRST204`
 * when a write names a column the table does not have. On this upsert there are
 * exactly TWO columns it can be — `confidence` and `provider_version`, both
 * added by migration 2991 — so saying so turns an opaque, silent write failure
 * into an operator instruction.
 *
 * Deliberately NARROW. A unique-violation, a permission denial or a dropped
 * connection are none of them a pending migration, and folding them in here
 * would restore exactly the silence this function exists to end: the retry
 * below would strip two harmless columns, fail again for the real reason, and
 * report the wrong cause.
 */
export function isMissingTranslationConfidenceColumn(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === '42703' || code === 'PGRST204') return true;
  // A code the database DID give us, and that is not one of the two above, is a
  // DIFFERENT failure — whatever its text happens to say. Postgres spells a
  // column-level privilege refusal `permission denied for column confidence of
  // relation message_translations` (42501), and a not-null violation `null
  // value in column "provider_version" violates not-null constraint` (23502);
  // both match the two patterns below word for word. Reading either as a
  // pending migration would latch the process-wide flag on a database where
  // 2991 IS applied, and every later translation in that process would silently
  // lose its confidence reading for a reason that was never about the schema.
  // So the text is consulted ONLY for the codeless shapes — the errors
  // supabase-js passes through without a SQLSTATE.
  if (typeof code === 'string' && code.length > 0) return false;
  const message = String((err as { message?: unknown }).message ?? '');
  return /(confidence|provider_version)/.test(message) && /column|schema cache/i.test(message);
}

export const CONFIDENCE_MIGRATION_PENDING_MESSAGE =
  'message_translations.confidence and .provider_version need migration ' +
  '2991_message_translations_confidence.sql, which is written and has not been ' +
  'applied to this database. The translation was stored WITHOUT them, so §18.2 ' +
  "T242's show-both decision has no reading to work from and falls back to " +
  'treating this translation as not-certain.';

/**
 * The row this table takes, in both shapes it can be written in.
 *
 * Spelled as TYPES rather than built by spreading a base object, because
 * `check:write-path-columns` resolves an upsert payload STATICALLY: a payload
 * assembled into a `Record<string, unknown>` and then mutated is a blind spot
 * where NONE of these column names is verified against the live schema. The
 * cost is that the nine shared fields are written out twice, at the two
 * `.upsert(` calls below; the annotation is what stops the two drifting, since
 * a field missing from either literal is a compile error rather than a column
 * that quietly stops being written.
 */
type TranslationRowBase = {
  message_id: string;
  recipient_id: string;
  source_language: string;
  target_language: string;
  translated_body: string | null;
  provider: string | null;
  status: TranslationStatusValue;
  error_message: string | null;
  updated_at: string;
};
type TranslationRowWithConfidence = TranslationRowBase & {
  confidence: TranslationConfidence | null;
  provider_version: string | null;
};

/**
 * Whether this process has already learned that 2991 is not applied here.
 *
 * Without it every single recipient of every single message pays a failed
 * round-trip to rediscover the same fact. It is a per-process cache of a
 * schema fact, so it is never negated back: a migration cannot un-apply itself
 * mid-process, and if the column DOES appear the next boot picks it up.
 */
let confidenceColumnsAbsent = false;

/**
 * Write one recipient's translation row.
 *
 * ── THIS FUNCTION USED TO BE `await sc.from(...).upsert(...)` AND NOTHING ELSE
 * supabase-js RESOLVES on a database error rather than throwing, so the awaited
 * promise settled happily on a refusal and every caller below — including the
 * `catch` arms whose entire job is to RECORD that a translation failed — could
 * not tell a written row from a rejected one. A recipient whose row was refused
 * looked, to every reader, exactly like a recipient the pipeline never reached.
 * The error is now read, and a failure is logged by name.
 */
async function upsertTranslation(
  sc: SupabaseClient,
  row: {
    messageId: string;
    recipientId: string;
    sourceLanguage: string;
    targetLanguage: string;
    translatedBody: string | null;
    provider: string | null;
    providerVersion: string | null;
    confidence: TranslationConfidence | null;
    status: TranslationStatusValue;
    errorMessage: string | null;
  },
  logger?: Logger,
  beforeWrite?: () => Promise<boolean>,
): Promise<'written' | 'withheld' | 'failed'> {
  const now = new Date().toISOString();

  // Two literal payloads at two `.upsert(` calls, chosen by the flag — the same
  // shape the membership reads in routes/messaging.ts use, and for the same
  // reason: one computed payload would leave every column here unverified.
  const withConfidence: TranslationRowWithConfidence = {
    message_id: row.messageId,
    recipient_id: row.recipientId,
    source_language: row.sourceLanguage,
    target_language: row.targetLanguage,
    translated_body: row.translatedBody,
    provider: row.provider,
    status: row.status,
    error_message: row.errorMessage,
    updated_at: now,
    confidence: row.confidence,
    provider_version: row.providerVersion,
  };
  const withoutConfidence: TranslationRowBase = {
    message_id: row.messageId,
    recipient_id: row.recipientId,
    source_language: row.sourceLanguage,
    target_language: row.targetLanguage,
    translated_body: row.translatedBody,
    provider: row.provider,
    status: row.status,
    error_message: row.errorMessage,
    updated_at: now,
  };

  if (beforeWrite && await beforeWrite() !== true) return 'withheld';
  const { error } = confidenceColumnsAbsent
    ? await sc
        .from('message_translations')
        .upsert(withoutConfidence, { onConflict: 'message_id,recipient_id' })
    : await sc
        .from('message_translations')
        .upsert(withConfidence, { onConflict: 'message_id,recipient_id' });
  if (!error) return 'written';

  if (!confidenceColumnsAbsent && isMissingTranslationConfidenceColumn(error)) {
    // 2991 is not applied here. Store the row WITHOUT the two new columns
    // rather than losing it: the translation itself is the product feature and
    // the confidence reading is metadata about it. Losing the row to keep the
    // metadata would be the wrong trade, and it is stated here so nobody reads
    // this fallback as the columns being optional.
    confidenceColumnsAbsent = true;
    logger?.warn(
      { messageId: row.messageId, recipientId: row.recipientId, err: (error as { code?: string }).code },
      CONFIDENCE_MIGRATION_PENDING_MESSAGE,
    );
    if (beforeWrite && await beforeWrite() !== true) return 'withheld';
    const retry = await sc
      .from('message_translations')
      .upsert(withoutConfidence, { onConflict: 'message_id,recipient_id' });
    if (!retry.error) return 'written';
    logger?.error(
      { messageId: row.messageId, recipientId: row.recipientId, status: row.status, err: (retry.error as { code?: string }).code },
      'translation_upsert_failed',
    );
    return 'failed';
  }

  logger?.error(
    { messageId: row.messageId, recipientId: row.recipientId, status: row.status, err: (error as { code?: string }).code },
    'translation_upsert_failed',
  );
  return 'failed';
}

/** Test-only: forget what this process learned about 2991. */
export function __resetConfidenceColumnProbe(): void {
  confidenceColumnsAbsent = false;
}

// ── Read (for the thread readers) ─────────────────────────────────────────────

/**
 * One recipient's translation row as the thread readers need it, CONFIDENCE
 * INCLUDED.
 *
 * §18.2 T242 — before this reader existed, `routes/messaging.ts` and
 * `routes/groupChat.ts` each selected four named fields and `status`, so the
 * stored `confidence` never reached `buildDisplayFields` and the show-both
 * decision was computed and thrown away. Both readers now go through here.
 *
 * Migration 2991 is applied to no database yet. Selecting a column a table does
 * not have is a 42703 / PGRST204, and that error used to be indistinguishable,
 * to these readers, from "translations unreadable". So the missing-column case
 * is recognised BY NAME (the same narrow predicate the writer uses), the read
 * is repeated without the column, and every row comes back with
 * `confidence: null` — which `buildDisplayFields` treats as NOT high, never as
 * certain. Any other error is returned untouched for the caller's existing
 * failed-read arm: a permission denial or a dropped connection is not a
 * pending migration.
 */
export interface RecipientTranslationRow {
  message_id: string;
  source_language: string;
  target_language: string;
  translated_body: string | null;
  status: TranslationStatusValue;
  confidence: TranslationConfidence | null;
}

const RECIPIENT_TRANSLATION_FIELDS = 'message_id, source_language, target_language, translated_body, status';

function confidenceOrNull(v: unknown): TranslationConfidence | null {
  return v === 'high' || v === 'low' ? v : null;
}

export async function readRecipientTranslations(
  sc: SupabaseClient,
  messageIds: readonly string[],
  recipientId: string,
): Promise<{ rows: RecipientTranslationRow[]; error: unknown | null }> {
  if (messageIds.length === 0) return { rows: [], error: null };
  if (!confidenceColumnsAbsent) {
    const { data, error } = await sc
      .from('message_translations')
      .select('message_id, source_language, target_language, translated_body, status, confidence')
      .in('message_id', messageIds as string[])
      .eq('recipient_id', recipientId);
    if (!error) {
      return {
        rows: ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
          ...(r as unknown as Omit<RecipientTranslationRow, 'confidence'>),
          confidence: confidenceOrNull(r.confidence),
        })),
        error: null,
      };
    }
    if (!isMissingTranslationConfidenceColumn(error)) return { rows: [], error };
    confidenceColumnsAbsent = true;
  }
  const { data, error } = await sc
    .from('message_translations')
    .select(RECIPIENT_TRANSLATION_FIELDS)
    .in('message_id', messageIds as string[])
    .eq('recipient_id', recipientId);
  if (error) return { rows: [], error };
  return {
    rows: ((data ?? []) as unknown as Array<Omit<RecipientTranslationRow, 'confidence'>>).map((r) => ({
      ...r,
      confidence: null,
    })),
    error: null,
  };
}
