/**
 * §18 T240 / T242 — the two `MessageTranslation` fields that were missing, and
 * the decision they exist to drive.
 *
 * census-telegraph T240: *"Six of eight fields … **Missing `providerVersion`
 * and `confidence`** — and the absence of `confidence` is what makes T242
 * fail."*  T242: *"the mechanism exists … but it is driven by a **user
 * preference** … There is no confidence value to threshold on."*
 *
 * The confidence signal was NOT absent from this tree. `DetectLanguageResult`
 * has carried `confidence: 'high' | 'low'` since the provider abstraction was
 * written (`lib/translation.ts`), and `detectWithRetry` threw it away one line
 * after receiving it — `return result.language`. So the value existed at the
 * provider boundary, was discarded before any caller could see it, and the
 * census correctly measured its absence from the record.
 *
 * WHAT IS ASSERTED HERE
 * =====================
 *   1. `translationConfidenceOf` — the pure rule. HIGH is reachable only when
 *      the PROVIDER read the text and said so. Every fallback arm is LOW,
 *      because a source language taken from a profile default (or from a read
 *      that FAILED) is a guess, and a translation out of a guessed source
 *      language is not a certain translation.
 *   2. `buildDisplayFields` — T242's decision. A translation that is not known
 *      to be high-confidence is presented WITH its original rather than in
 *      place of it, and that decision is taken from the confidence value, not
 *      from `profiles.show_original_messages`.
 *   3. UNKNOWN IS NOT HIGH. A row written before migration 2991 carries no
 *      confidence at all. Treating that as certain is exactly the "pretending
 *      certainty" T242 forbids, so it shows both.
 *   4. `providerVersion` — the engine identity travels with the translation and
 *      is the SAME string the provider actually ran, not a literal beside it.
 *
 * MUTATION REQUIREMENT, stated so a later reader can check this file is still
 * doing its job:
 *   - relaxing `translationConfidenceOf` to return 'high' on any non-provider
 *     arm must fail "a guessed source language can never yield a high-confidence
 *     translation".
 *   - flipping `showOriginalAlongside` to `confidence === 'low'` (so UNKNOWN
 *     reads as certain) must fail "an unrecorded confidence is not a high one".
 *   - dropping `providerVersion` from the mock provider must fail "the provider
 *     names the engine that actually ran".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDisplayFields,
  translationConfidenceOf,
  isMissingTranslationConfidenceColumn,
  CONFIDENCE_MIGRATION_PENDING_MESSAGE,
} from '../services/messageTranslation.js';
import { MockTranslationProvider } from '../lib/translation.js';

describe('§18 T240 — translationConfidenceOf is the confidence the record was missing', () => {
  it('is HIGH only when the provider read the text and said high', () => {
    assert.equal(
      translationConfidenceOf({ detectionSource: 'provider', detectionConfidence: 'high' }),
      'high',
    );
  });

  it('is LOW when the provider read the text and was unsure', () => {
    assert.equal(
      translationConfidenceOf({ detectionSource: 'provider', detectionConfidence: 'low' }),
      'low',
    );
  });

  it('a guessed source language can never yield a high-confidence translation', () => {
    // All three fallback arms of the detection ladder. None of them read the
    // message text, so none of them can license certainty about it — even if a
    // stale confidence value were somehow handed in alongside.
    for (const source of ['sender_preference', 'default', 'sender_preference_unreadable'] as const) {
      assert.equal(
        translationConfidenceOf({ detectionSource: source, detectionConfidence: 'high' }),
        'low',
        `${source} must not be able to claim high confidence`,
      );
    }
  });

  it('a missing confidence reading is LOW, not absent', () => {
    assert.equal(
      translationConfidenceOf({ detectionSource: 'provider', detectionConfidence: null }),
      'low',
    );
  });
});

describe('§18 T242 — a translation that is not certain is shown WITH its original', () => {
  const msg = { body: 'hola', deleted: false, senderId: 'sender', originalLanguage: 'es' };
  const me = 'recipient';

  function row(confidence: 'high' | 'low' | null) {
    return {
      source_language: 'es',
      target_language: 'en',
      translated_body: 'hello',
      status: 'translated' as const,
      confidence,
    };
  }

  it('LOW confidence asks for both, and says which is which', () => {
    const d = buildDisplayFields(msg, me, row('low'));
    assert.equal(d.translated, true);
    assert.equal(d.translationConfidence, 'low');
    assert.equal(d.showOriginalAlongside, true);
    // Both texts are present and distinguishable — the translation never
    // replaces the original on the wire.
    assert.equal(d.displayBody, 'hello');
    assert.equal(d.originalBody, 'hola');
  });

  it('HIGH confidence does not force the original alongside', () => {
    const d = buildDisplayFields(msg, me, row('high'));
    assert.equal(d.translated, true);
    assert.equal(d.translationConfidence, 'high');
    assert.equal(d.showOriginalAlongside, false);
    // Still AVAILABLE — T241's "the original is never replaced" is unchanged.
    assert.equal(d.canShowOriginal, true);
    assert.equal(d.originalBody, 'hola');
  });

  it('an unrecorded confidence is not a high one', () => {
    const d = buildDisplayFields(msg, me, row(null));
    assert.equal(d.translationConfidence, null);
    assert.equal(d.showOriginalAlongside, true);
  });

  it('the decision is the confidence value and nothing else — no preference is read', () => {
    // buildDisplayFields takes three arguments and none of them is a profile.
    // Stated as an assertion rather than as a comment so a later signature
    // change that smuggles a preference in has to break this line.
    assert.equal(buildDisplayFields.length, 3);
  });

  it('a non-translated message never asks for both', () => {
    for (const status of ['skipped', 'pending', 'failed'] as const) {
      const d = buildDisplayFields(msg, me, { ...row('low'), status });
      assert.equal(d.showOriginalAlongside, false, `${status} must not ask for both`);
      assert.equal(d.translated, false);
    }
    // The sender's own message, and a message with no translation row.
    assert.equal(buildDisplayFields(msg, 'sender', row('low')).showOriginalAlongside, false);
    assert.equal(buildDisplayFields(msg, me, null).showOriginalAlongside, false);
  });

  it('a deleted message discloses neither body, whatever the confidence says', () => {
    const d = buildDisplayFields({ ...msg, deleted: true, body: null }, me, row('low'));
    assert.equal(d.displayBody, null);
    assert.equal(d.originalBody, null);
    assert.equal(d.showOriginalAlongside, false);
    assert.equal(d.translationConfidence, null);
  });

  it('`deleted` alone suppresses the body — a caller that did not pre-null it is not trusted', () => {
    // WIDENED INPUT, and the reason is recorded rather than left as a wider
    // case for its own sake. With `body: null` passed alongside `deleted: true`
    // the first arm of `buildDisplayFields` is UNFALSIFIABLE: the two halves of
    // `msg.deleted || msg.body === null` cannot be told apart, so replacing the
    // arm's `null`s with `msg.body` changes nothing and the guard looks
    // redundant. It is not. This function is exported, both its current callers
    // pre-null the body (`body: isDeleted ? null : m.body`), and the day a third
    // one does not, `deleted` is the only thing standing between a tombstoned
    // message and its text. Asserted with the body PRESENT so the `deleted`
    // half of that disjunction carries a test of its own.
    const d = buildDisplayFields(
      { ...msg, deleted: true, body: 'the text of an unsent message' },
      me,
      row('high'),
    );
    assert.equal(d.displayBody, null);
    assert.equal(d.originalBody, null);
    assert.equal(d.translationStatus, null);
    assert.equal(d.canShowOriginal, false);
    assert.equal(d.showOriginalAlongside, false);
  });
});

describe('§18 T240 — providerVersion travels with the translation', () => {
  it('the provider names the engine that actually ran', async () => {
    const out = await new MockTranslationProvider().translateText('hola', 'es', 'en');
    assert.equal(out.provider, 'mock');
    assert.equal(typeof out.providerVersion, 'string');
    assert.ok(out.providerVersion.length > 0, 'providerVersion must not be empty');
  });
});

describe('migration 2991 is written and applied nowhere — the writer says so by name', () => {
  it('recognises the undefined-column refusal by SQLSTATE and by PostgREST code', () => {
    assert.equal(isMissingTranslationConfidenceColumn({ code: '42703' }), true);
    assert.equal(isMissingTranslationConfidenceColumn({ code: 'PGRST204' }), true);
    assert.equal(
      isMissingTranslationConfidenceColumn({ message: "column message_translations.confidence does not exist" }),
      true,
    );
    assert.equal(
      isMissingTranslationConfidenceColumn({ message: "column message_translations.provider_version does not exist" }),
      true,
    );
  });

  it('does NOT swallow an unrelated failure as a pending migration', () => {
    assert.equal(isMissingTranslationConfidenceColumn({ code: '23505' }), false);
    assert.equal(isMissingTranslationConfidenceColumn({ code: '42501' }), false);
    assert.equal(isMissingTranslationConfidenceColumn(null), false);
    assert.equal(isMissingTranslationConfidenceColumn(undefined), false);
    assert.equal(isMissingTranslationConfidenceColumn({ message: 'connection reset' }), false);
  });

  it('names the migration rather than answering with a generic failure', () => {
    assert.match(CONFIDENCE_MIGRATION_PENDING_MESSAGE, /2991/);
    assert.match(CONFIDENCE_MIGRATION_PENDING_MESSAGE, /message_translations/);
  });
});
