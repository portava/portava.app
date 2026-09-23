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
} from '../lib/translation';
import { publishToUsers } from '../lib/telegraphEvents';
// The envelope version literal only — NOT the kind registry. See
// `isStructuredEnvelopeBody` for why the guard is invariant-based rather than
// kind-based.
import { KIND_ENVELOPE_VERSION } from './telegraph/messageKinds.js';

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
 * How certain the record is that this translation says what the original said.
 *
 * census-telegraph T240 named `confidence` as one of two fields
 * `MessageTranslation` was missing, and T242 named its absence as the reason
 * the show-original mechanism is driven by a user preference instead of by the
 * translation itself.
 *
 * TWO VALUES, NOT A NUMBER. The only certainty signal this tree actually has is
 * the provider's own `'high' | 'low'` language detection, and inventing a
 * float from it would be a precision the source does not carry. A third value
 * for "not recorded" is deliberately NOT in this type: absence is spelled
 * `null` at every boundary, because a row written before migration 2991 has no
 * reading at all and an enum member called `unknown` would have looked like one.
 */
export type TranslationConfidence = 'high' | 'low';

/**
 * translationConfidenceOf — the one rule that decides it.
 *
 * HIGH IS REACHABLE ONLY THROUGH THE PROVIDER ARM, and that is the whole
 * content of this function. `translateMessageForThread` resolves the source
 * language down a four-arm ladder: the provider read the text, or the sender's
 * stated preference was used, or the server default was used because the
 * sender stated nothing, or the server default was used because the profile
 * READ FAILED. Only the first of those four looked at the message.
 *
 * A translation out of a guessed source language is a guess. `es → en` run
 * against text that is actually Portuguese produces fluent, confident,
 * wrong English — which is precisely the failure §18.2 describes and asks to
 * be surfaced rather than smoothed over. So the three fallback arms are LOW
 * even if a confidence reading is somehow handed in beside them: the
 * `detectionConfidence` argument is a statement about a detection that, in
 * those arms, did not happen.
 *
 * The TARGET language is not an input. It is the recipient's own stated
 * preference, read from their profile; there is nothing uncertain about it.
 */
export function translationConfidenceOf(input: {
  detectionSource: LanguageDetectionSource;
  detectionConfidence: TranslationConfidence | null;
}): TranslationConfidence {
  if (input.detectionSource !== 'provider') return 'low';
  return input.detectionConfidence === 'high' ? 'high' : 'low';
}

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
  /**
   * The stored reading, or `null` when none was recorded. `null` is a real
   * state and not a defect: migration 2991 is applied to no database, so every
   * row that exists today carries no confidence at all.
   */
  translationConfidence: TranslationConfidence | null;
  /**
   * §18.2 T242 — SHOW BOTH rather than pretend certainty.
   *
   * True when a translation is being displayed and the record does not say it
   * is high-confidence. It is a statement about the TRANSLATION, not about the
   * viewer: `canShowOriginal` says the original is available to ask for, and
   * `profiles.show_original_messages` says the viewer likes to see it — this
   * says the translation is not certain enough to stand alone, which neither of
   * those two can express.
   *
   * UNKNOWN COUNTS AS NOT-HIGH. The requirement is "instead of pretending
   * certainty", and a missing reading is not evidence of certainty; it is the
   * absence of evidence. Deciding it the other way would make every row written
   * before 2991 assert a confidence nobody measured.
   */
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

/**
 * Detect the source language AND keep what the provider said about its own
 * certainty.
 *
 * This function used to end `return result.language`, and that single
 * discarded field is the whole of census-telegraph T240's missing `confidence`
 * and T242's "there is no confidence value to threshold on".
 * `DetectLanguageResult.confidence` has existed since the provider abstraction
 * was written; nothing downstream could see it.
 */
async function detectWithRetry(
  text: string,
  maxRetries: number,
): Promise<{ language: string; confidence: TranslationConfidence }> {
  const provider = getTranslationProvider();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await withTimeout(provider.detectLanguage(text), TRANSLATION_TIMEOUT_MS);
      return { language: result.language, confidence: result.confidence };
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
): Promise<TranslateTextResult> {
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
    // 1. Get all thread members (other than the sender).
    //
    // census T344/T363. Dropped, this read ENDED the pipeline in silence: an
    // unreadable `message_thread_members` resolved as `data: null`, `?? []` made
    // it "this thread has nobody else in it", and the early return below fired.
    // No translation row was written for anybody and nothing anywhere recorded
    // that a thread had gone untranslated — the outcome is byte-identical to a
    // thread the sender is alone in.
    //
    // There is no honest row to write instead: without the roster there are no
    // recipient ids to key one by. What the failure is owed is a LOUD, and the
    // pipeline's own contract ("never throws") means that loud is a log at
    // error level, the level its outer catch already uses.
    const { data: members, error: membersErr } = await sc
      .from('message_thread_members')
      .select('user_id')
      .eq('thread_id', threadId)
      .neq('user_id', senderId);

    if (membersErr) {
      logger?.error(
        { messageId, threadId, err: membersErr.message },
        'thread roster unreadable — no recipient can be translated for, and this is not a solo thread',
      );
      return;
    }

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
    // What the PROVIDER said about its own reading, or null when no provider
    // reading happened. Never defaulted to a value: `translationConfidenceOf`
    // is the only thing that turns this into a verdict.
    let detectionConfidence: TranslationConfidence | null = null;
    try {
      const detected = await detectWithRetry(body, 1);
      sourceLanguage = detected.language;
      detectionConfidence = detected.confidence;
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

    // §18.2 T240/T242. Computed ONCE, from the detection ladder's outcome, and
    // written onto every recipient's row: the uncertainty is a property of how
    // this MESSAGE's source language was established, not of who is reading it.
    const messageConfidence = translationConfidenceOf({ detectionSource, detectionConfidence });

    // Update the message with detected language.
    await sc
      .from('messages')
      .update({ original_language: sourceLanguage, language_detection_source: detectionSource })
      .eq('id', messageId);

    // 3. Fetch recipient language preferences.
    // preferred_language (user-chosen in Settings) takes priority over
    // preferred_message_language (legacy auto-translate field).
    //
    // ── THE OTHER END OF THE SAME DEFECT §16 FIXED FOR THE SENDER ────────────
    // census T344/T363, named by census-telegraph §16.4 as the consequence that
    // lane found inside its own file and did not fix. With the error dropped,
    // an unreadable `profiles` gave EVERY recipient the map's default —
    // `preferredLanguage: 'en'`, `autoTranslate: true` — and §16.4 read that as
    // a degradation rather than a false claim. Executing it shows it is a false
    // claim: when the source language is also 'en', which is the common case,
    // the same-language arm below writes `status: 'skipped'` with
    // `target_language: 'en'` for each recipient, and that row asserts, durably
    // and queryably, that this recipient reads English and needed nothing. Not
    // one byte about that recipient was read.
    const { data: profiles, error: profilesErr } = await sc
      .from('profiles')
      .select('id, preferred_language, preferred_message_language, auto_translate_messages')
      .in('id', recipientIds);

    if (profilesErr) {
      logger?.warn(
        { messageId, threadId, recipients: recipientIds.length, err: profilesErr.message },
        'recipient language preferences unreadable — recording failed translations, not skipped ones',
      );
    }

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
      // The read FAILED, so nothing is known about this recipient's language or
      // their auto-translate setting. `failed` is §18's own word for "we did not
      // translate this", it is what `buildDisplayFields` already renders as the
      // untouched original with no banner — so what the reader SEES is unchanged
      // — and `error_message` carries which failure it was. `target_language`
      // is NOT NULL and no preference was read, so it takes `und`, the code this
      // tree already writes for an undetermined language in the same situation
      // (`routes/messaging.ts`, the per-viewer translation read).
      if (profilesErr) {
        await upsertTranslation(sc, {
          messageId,
          recipientId,
          sourceLanguage,
          targetLanguage: UNKNOWN_LANGUAGE,
          translatedBody: null,
          provider: null,
          providerVersion: null,
          // Nothing was translated, so there is nothing to be confident about.
          // A confidence on a non-translation would be a reading of a text that
          // was never produced.
          confidence: null,
          status: 'failed',
          errorMessage: 'recipient_preferences_unreadable',
        }, logger);
        continue;
      }

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
          providerVersion: null,
          confidence: null,
          status: 'skipped',
          errorMessage: 'auto_translate_disabled',
        }, logger);
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
          providerVersion: null,
          confidence: null,
          status: 'skipped',
          errorMessage: null,
        }, logger);
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
            providerVersion: result.providerVersion,
            confidence: null,
            status: 'failed',
            errorMessage: `validation_${validation.reason ?? 'unknown'}`,
          }, logger);
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
          providerVersion: result.providerVersion,
          confidence: messageConfidence,
          status: 'translated',
          errorMessage: null,
        }, logger);
        logger?.info(
          {
            messageId,
            recipientId,
            source: sourceLanguage,
            target: targetLanguage,
            provider: result.provider,
            providerVersion: result.providerVersion,
            confidence: messageConfidence,
          },
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
          providerVersion: null,
          confidence: null,
          status: 'failed',
          errorMessage: errCode,
        }, logger);
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
    // `language_detection_source` is a plain nullable text column that has
    // existed since 0009 and is written by the pipeline above on every message,
    // so naming it here cannot fail on any database. It is read for exactly one
    // reason: §18.2 T242's confidence, below.
    const { data: messages, error: msgErr } = await sc
      .from('messages')
      .select('id, body, original_language, language_detection_source')
      .in('id', messageIds);

    if (msgErr) {
      logger?.warn({ err: msgErr.message, userId }, 'retranslate_messages_fetch_failed');
      return;
    }

    const msgMap: Record<
      string,
      { body: string; originalLanguage: string | null; detectionSource: LanguageDetectionSource | null }
    > = {};
    for (const m of messages ?? []) {
      msgMap[(m as any).id] = {
        body: (m as any).body as string,
        originalLanguage: (m as any).original_language as string | null,
        detectionSource: ((m as any).language_detection_source ?? null) as LanguageDetectionSource | null,
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

      // §18.2 T240/T242 — THIS SWEEP TAKES NO READING OF ITS OWN.
      //
      // A re-translation changes the TARGET language; it re-uses the source
      // language established when the message was first processed and never
      // calls `detectLanguage` again. So there is no fresh
      // `detectionConfidence` to pass, and this deliberately passes `null`
      // rather than copying forward a reading the sweep did not take.
      //
      // Routed through the same one rule as the live pipeline rather than
      // hard-coding the answer, so that a later lane which DOES re-detect here
      // only has to supply the second argument. A message whose language was
      // never provider-detected — or whose `language_detection_source` predates
      // that column — cannot reach 'high' through this path, which is the
      // honest outcome: nothing here read the text.
      const sweepConfidence = translationConfidenceOf({
        detectionSource: msg.detectionSource ?? 'default',
        detectionConfidence: null,
      });

      // Same language as target — mark skipped.
      if (sourceLanguage === newTargetLanguage) {
        await upsertTranslation(sc, {
          messageId,
          recipientId: userId,
          sourceLanguage,
          targetLanguage: newTargetLanguage,
          translatedBody: null,
          provider: null,
          providerVersion: null,
          confidence: null,
          status: 'skipped',
          errorMessage: null,
        }, logger);
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
            providerVersion: result.providerVersion,
            confidence: null,
            status: 'failed',
            errorMessage: `validation_${validation.reason ?? 'unknown'}`,
          }, logger);
          continue;
        }
        await upsertTranslation(sc, {
          messageId,
          recipientId: userId,
          sourceLanguage,
          targetLanguage: newTargetLanguage,
          translatedBody: result.translatedText,
          provider: result.provider,
          providerVersion: result.providerVersion,
          confidence: sweepConfidence,
          status: 'translated',
          errorMessage: null,
        }, logger);
      } catch (e: unknown) {
        const errCode = e instanceof Error ? (e.message.length < 80 ? e.message : 'translation_error') : 'unknown';
        await upsertTranslation(sc, {
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
        }, logger);
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
    /**
     * §18.2 T240. OPTIONAL at the type level because migration 2991 is applied
     * to no database: every caller in this tree today passes a row that has no
     * such column, and `undefined` and `null` both mean "no reading", which is
     * handled as NOT-HIGH below rather than as high.
     */
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

  // §18.2 T242 — THE ONLY ARM WHERE A TRANSLATION IS ACTUALLY BEING SHOWN.
  //
  // `confidence` decides whether it stands alone. It is read from the RECORD,
  // not from `profiles.show_original_messages`: the preference says what this
  // viewer likes to see, and this says whether the translation is good enough
  // to be believed without its source. A row with no reading is not a
  // high-confidence row — see `showOriginalAlongside`'s own comment.
  const confidence = translationRow.confidence ?? null;
  const sourceName = languageDisplayName(source_language);
  return {
    displayBody: translatedText,
    originalBody: msg.body,
    originalLanguage: source_language,
    translated: true,
    translationStatus: 'translated',
    translationLabel:
      confidence === 'high'
        ? `Translated from ${sourceName}`
        // The label carries the uncertainty too, so a surface that renders only
        // the label still tells the truth about it rather than presenting an
        // unsure translation in the same words as a sure one.
        : `Translated from ${sourceName} — shown with the original`,
    canShowOriginal: true,
    translationConfidence: confidence,
    showOriginalAlongside: confidence !== 'high',
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
): Promise<void> {
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

  const { error } = confidenceColumnsAbsent
    ? await sc
        .from('message_translations')
        .upsert(withoutConfidence, { onConflict: 'message_id,recipient_id' })
    : await sc
        .from('message_translations')
        .upsert(withConfidence, { onConflict: 'message_id,recipient_id' });
  if (!error) return;

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
    const retry = await sc
      .from('message_translations')
      .upsert(withoutConfidence, { onConflict: 'message_id,recipient_id' });
    if (!retry.error) return;
    logger?.error(
      { messageId: row.messageId, recipientId: row.recipientId, status: row.status, err: (retry.error as { code?: string }).code },
      'translation_upsert_failed',
    );
    return;
  }

  logger?.error(
    { messageId: row.messageId, recipientId: row.recipientId, status: row.status, err: (error as { code?: string }).code },
    'translation_upsert_failed',
  );
}

/** Test-only: forget what this process learned about 2991. */
export function __resetConfidenceColumnProbe(): void {
  confidenceColumnsAbsent = false;
}
