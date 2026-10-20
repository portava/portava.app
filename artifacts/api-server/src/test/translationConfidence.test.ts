import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDisplayFields,
  translateMessageForThread,
  __resetConfidenceColumnProbe,
  isMissingTranslationConfidenceColumn,
  CONFIDENCE_MIGRATION_PENDING_MESSAGE,
} from '../services/messageTranslation.js';
import { MockTranslationProvider, _setTestTranslationProvider } from '../lib/translation.js';
import { makeFakeClient } from './telegraphCertificationHarness.js';

describe('T242 — language detection is not a translation-quality measurement', () => {
  afterEach(() => {
    _setTestTranslationProvider(null);
    __resetConfidenceColumnProbe();
  });

  for (const scenario of [
    { detection: 'high', preference: null, unreadable: false, source: 'provider', language: 'es' },
    { detection: 'low', preference: null, unreadable: false, source: 'provider', language: 'es' },
    { detection: null, preference: 'it', unreadable: false, source: 'sender_preference', language: 'it' },
    { detection: null, preference: null, unreadable: false, source: 'default', language: 'en' },
    { detection: null, preference: null, unreadable: true, source: 'sender_preference_unreadable', language: 'en' },
  ] as const) {
    it(`writes unknown quality for ${scenario.source}/${scenario.detection}, preserving original and provenance`, async () => {
      const original = 'Nos vemos en el muelle a las ocho.';
      const translated = 'Rendez-vous au quai à huit heures.';
      _setTestTranslationProvider({
        async detectLanguage() {
          if (scenario.detection === null) throw new Error('detector_unavailable');
          return { language: 'es', confidence: scenario.detection };
        },
        async translateText(text, source, target) {
          assert.equal(text, original);
          assert.equal(source, scenario.language);
          assert.equal(target, 'fr');
          return { translatedText: translated, provider: 'test', providerVersion: 'test-v1' };
        },
      });
      const client = makeFakeClient({
        feature_flags: [], blocks: [],
        messages: [{ id: 'message', body: original, thread_id: 'thread', sender_id: 'sender',
          created_at: '2026-10-01T00:00:00.000Z', edited_at: null, deleted_at: null, ciphertext: null,
          original_language: null, language_detection_source: null }],
        message_threads: [{ id: 'thread', is_e2ee: false }],
        message_thread_members: [{ thread_id: 'thread', user_id: 'recipient', left_at: null }],
        profiles: [{ id: 'recipient', preferred_language: 'fr', auto_translate_messages: true }],
        message_translations: [],
      });

      await translateMessageForThread(client as any, {
        messageId: 'message', body: original, senderId: 'sender', threadId: 'thread',
        senderPreferredLanguage: scenario.preference,
        senderPreferenceUnreadable: scenario.unreadable,
      });

      const stored = client._store.message_translations[0];
      assert.equal(stored.status, 'translated');
      assert.equal(stored.confidence, null);
      assert.equal(stored.translated_body, translated);
      assert.equal(stored.provider_version, 'test-v1');
      assert.equal(client._store.messages[0].body, original);
      assert.equal(client._store.messages[0].original_language, scenario.language);
      assert.equal(client._store.messages[0].language_detection_source, scenario.source);
      const display = buildDisplayFields({ body: original, deleted: false, senderId: 'sender' }, 'recipient', stored);
      assert.equal(display.translationConfidence, null);
      assert.equal(display.showOriginalAlongside, true);
      assert.equal(display.originalBody, original);
    });
  }
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

  it('legacy LOW detection confidence is unknown translation quality and asks for both', () => {
    const d = buildDisplayFields(msg, me, row('low'));
    assert.equal(d.translated, true);
    assert.equal(d.translationConfidence, null);
    assert.equal(d.showOriginalAlongside, true);
    // Both texts are present and distinguishable — the translation never
    // replaces the original on the wire.
    assert.equal(d.displayBody, 'hello');
    assert.equal(d.originalBody, 'hola');
  });

  it('legacy HIGH detection confidence cannot hide the original or claim quality', () => {
    const d = buildDisplayFields(msg, me, row('high'));
    assert.equal(d.translated, true);
    assert.equal(d.translationConfidence, null);
    assert.equal(d.showOriginalAlongside, true);
    assert.equal(d.translationLabel, 'Translated from Spanish — quality unverified');
    // Still AVAILABLE — T241's "the original is never replaced" is unchanged.
    assert.equal(d.canShowOriginal, true);
    assert.equal(d.originalBody, 'hola');
  });

  it('an unrecorded confidence is not a high one', () => {
    const d = buildDisplayFields(msg, me, row(null));
    assert.equal(d.translationConfidence, null);
    assert.equal(d.showOriginalAlongside, true);
  });

  it('an older record without confidence keeps the existing display contract', () => {
    const display = buildDisplayFields(msg, me, {
      source_language: 'es', target_language: 'en', translated_body: 'hello', status: 'translated',
    });
    assert.deepEqual(display, {
      displayBody: 'hello',
      originalBody: 'hola',
      originalLanguage: 'es',
      translated: true,
      translationStatus: 'translated',
      translationLabel: 'Translated from Spanish — quality unverified',
      canShowOriginal: true,
      translationConfidence: null,
      showOriginalAlongside: true,
    });
  });

  it('unknown translation quality does not depend on a viewer preference', () => {
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
      assert.equal(d.displayBody, msg.body);
      assert.equal(d.originalBody, msg.body);
      assert.equal(d.translationConfidence, null);
      assert.equal(d.translationLabel, null);
      assert.equal(d.translationStatus, status);
    }
    // The sender's own message, and a message with no translation row.
    assert.equal(buildDisplayFields(msg, 'sender', row('low')).showOriginalAlongside, false);
    assert.equal(buildDisplayFields(msg, me, null).showOriginalAlongside, false);
  });

  it('empty or identical derivatives preserve original text without claiming a translation', () => {
    for (const translatedBody of [null, '', 'hola', ' hola ']) {
      const display = buildDisplayFields(msg, me, { ...row('high'), translated_body: translatedBody });
      assert.equal(display.displayBody, msg.body);
      assert.equal(display.originalBody, msg.body);
      assert.equal(display.translated, false);
      assert.equal(display.translationConfidence, null);
      assert.equal(display.translationLabel, null);
      assert.equal(display.showOriginalAlongside, false);
      assert.equal(display.canShowOriginal, false);
    }
  });

  it('own messages and missing derivatives retain the original without translation metadata', () => {
    for (const display of [
      buildDisplayFields(msg, 'sender', row('high')),
      buildDisplayFields(msg, me, null),
    ]) {
      assert.equal(display.displayBody, msg.body);
      assert.equal(display.originalBody, msg.body);
      assert.equal(display.translated, false);
      assert.equal(display.translationConfidence, null);
      assert.equal(display.translationStatus, null);
      assert.equal(display.translationLabel, null);
      assert.equal(display.showOriginalAlongside, false);
      assert.equal(display.canShowOriginal, false);
    }
  });

  it('an absent original cannot expose a stale derivative', () => {
    const display = buildDisplayFields({ ...msg, body: null }, me, row('high'));
    assert.equal(display.displayBody, null);
    assert.equal(display.originalBody, null);
    assert.equal(display.translated, false);
    assert.equal(display.translationConfidence, null);
    assert.equal(display.showOriginalAlongside, false);
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
