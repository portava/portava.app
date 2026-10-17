import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { _setTestTranslationProvider } from '../lib/translation.js';
import {
  __resetConfidenceColumnProbe,
  buildDisplayFields,
  retranslateForUser,
  translateMessageForThread,
  type LanguageDetectionSource,
  type TranslationStatusValue,
} from '../services/messageTranslation.js';
import { makeSchemaStrictClient, type SchemaStrictClient } from './helpers/schemaStrictSupabase.js';
import { makeFailClosedClient } from './helpers/failClosedSupabase.js';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const SENDER_ID = '22222222-2222-4222-8222-222222222222';
const RECIPIENT_ID = '33333333-3333-4333-8333-333333333333';
const THREAD_ID = '44444444-4444-4444-8444-444444444444';
const ORIGINAL = 'Nos vemos en el muelle a las ocho. No salgas todavía.';
const TRANSLATED = 'We will meet at the pier at eight. Do not leave yet.';

function client(options: {
  confidenceColumns: boolean;
  originalLanguage?: string | null;
  detectionSource?: LanguageDetectionSource | null;
  autoTranslate?: boolean;
}): SchemaStrictClient {
  const database = makeSchemaStrictClient({
    messages: [{
      id: MESSAGE_ID,
      thread_id: THREAD_ID,
      sender_id: SENDER_ID,
      created_at: '2026-10-01T00:00:00.000Z',
      edited_at: null,
      deleted_at: null,
      ciphertext: null,
      unsent_at: null,
      body: ORIGINAL,
      original_language: options.originalLanguage ?? null,
      language_detection_source: options.detectionSource ?? null,
    }],
    message_thread_members: [{ thread_id: THREAD_ID, user_id: RECIPIENT_ID, left_at: null }],
    message_threads: [{ id: THREAD_ID, is_e2ee: false }],
    profiles: [{
      id: RECIPIENT_ID,
      preferred_language: 'en',
      preferred_message_language: null,
      auto_translate_messages: options.autoTranslate ?? true,
    }],
    message_translations: [{
      message_id: MESSAGE_ID,
      recipient_id: RECIPIENT_ID,
      source_language: options.originalLanguage ?? 'en',
      target_language: 'fr',
      translated_body: 'Previously stored derivative.',
      status: 'translated',
      updated_at: '2026-10-01T00:00:00.000Z',
    }],
  }, options.confidenceColumns ? { unchecked: ['message_translations'] } : {});
  const from = database.from.bind(database);
  const blocks = makeFailClosedClient({ rows: { blocks: [] } });
  database.from = table => table === 'blocks' ? blocks.from(table) : from(table);
  return database;
}

function provider(detectedLanguage: string | null) {
  const detect = mock.fn(async () => {
    if (detectedLanguage === null) throw new Error('detection_unavailable');
    return { language: detectedLanguage, confidence: 'high' as const };
  });
  const translate = mock.fn(async () => ({
    translatedText: TRANSLATED,
    provider: 'offline-fixture',
    providerVersion: 'offline-fixture-1',
  }));
  _setTestTranslationProvider({ detectLanguage: detect, translateText: translate });
  return { detect, translate };
}

function landedRow(database: SchemaStrictClient) {
  const writes = database.writes.filter((write) => write.table === 'message_translations');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].rows.length, 1);
  const row = writes[0].rows[0];
  assert.equal(row.message_id, MESSAGE_ID);
  assert.equal(row.recipient_id, RECIPIENT_ID);
  assert.equal(row.target_language, 'en');
  assert.ok(database.writes.every((write) => write.rows.every((payload) => !('body' in payload))));
  return row;
}

function assertUnavailable(database: SchemaStrictClient, confidenceColumns: boolean) {
  const row = landedRow(database);
  assert.equal(row.status, 'failed');
  assert.equal(row.error_message, 'source_language_unverified');
  assert.equal(row.source_language, 'und');
  assert.equal(row.translated_body, null);
  assert.equal(row.provider, null);
  if (confidenceColumns) {
    assert.equal(row.confidence, null);
    assert.equal(row.provider_version, null);
    assert.deepEqual(database.deadColumnErrors, []);
  } else {
    assert.equal('confidence' in row, false);
    assert.equal('provider_version' in row, false);
    assert.deepEqual(database.deadColumnErrors.map((error) => error.column).sort(), ['confidence', 'provider_version']);
  }
  const display = buildDisplayFields({
    body: ORIGINAL,
    senderId: SENDER_ID,
    deleted: false,
    originalLanguage: 'en',
  }, RECIPIENT_ID, {
    source_language: String(row.source_language),
    target_language: String(row.target_language),
    translated_body: row.translated_body as string | null,
    status: row.status as TranslationStatusValue,
  });
  assert.equal(display.displayBody, ORIGINAL);
  assert.equal(display.originalBody, ORIGINAL);
  assert.equal(display.originalLanguage, 'und');
  assert.equal(display.translated, false);
  assert.equal(display.translationStatus, 'failed');
  assert.equal(display.translationLabel, null);
  assert.equal(display.translationConfidence, null);
  assert.equal(display.showOriginalAlongside, false);
}

beforeEach(() => {
  __resetConfidenceColumnProbe();
  mock.method(globalThis, 'fetch', async () => { throw new Error('network_forbidden'); });
});

afterEach(() => {
  _setTestTranslationProvider(null);
  mock.restoreAll();
});

for (const confidenceColumns of [true, false]) {
  describe(`assumed-source fallback with confidence columns ${confidenceColumns ? 'present' : 'absent'}`, () => {
    for (const preference of [
      { label: 'absent', language: null, unreadable: false },
      { label: 'unreadable', language: null, unreadable: true },
      { label: 'blank', language: '', unreadable: false },
      { label: 'stated but not detected', language: 'en', unreadable: false },
    ]) {
      it(`live: ${preference.label} sender preference cannot establish an English match`, async () => {
        const database = client({ confidenceColumns });
        const calls = provider(null);
        await translateMessageForThread(database as unknown as SupabaseClient, {
          messageId: MESSAGE_ID,
          body: ORIGINAL,
          senderId: SENDER_ID,
          threadId: THREAD_ID,
          senderPreferredLanguage: preference.language,
          senderPreferenceUnreadable: preference.unreadable,
        });
        assertUnavailable(database, confidenceColumns);
        assert.equal(calls.detect.mock.callCount(), 2);
        assert.equal(calls.translate.mock.callCount(), 0);
      });
    }

    for (const detectionSource of ['default', 'sender_preference_unreadable', 'sender_preference', null] as const) {
      it(`retranslation: ${detectionSource ?? 'legacy unknown'} source cannot establish an English match`, async () => {
        const database = client({ confidenceColumns, originalLanguage: 'en', detectionSource });
        const calls = provider(null);
        await retranslateForUser(database as unknown as SupabaseClient, RECIPIENT_ID, 'en');
        assertUnavailable(database, confidenceColumns);
        assert.equal(calls.detect.mock.callCount(), 0);
        assert.equal(calls.translate.mock.callCount(), 0);
      });
    }

    it('retranslation: falling back to the old translation row does not establish its source', async () => {
      const database = client({ confidenceColumns });
      const calls = provider(null);
      await retranslateForUser(database as unknown as SupabaseClient, RECIPIENT_ID, 'en');
      assertUnavailable(database, confidenceColumns);
      assert.equal(calls.detect.mock.callCount(), 0);
      assert.equal(calls.translate.mock.callCount(), 0);
    });
  });
}

describe('established-language and explicit opt-out controls', () => {
  it('live: provider-established same-language messages remain skipped', async () => {
    const database = client({ confidenceColumns: true });
    const calls = provider('en');
    await translateMessageForThread(database as unknown as SupabaseClient, {
      messageId: MESSAGE_ID, body: ORIGINAL, senderId: SENDER_ID, threadId: THREAD_ID,
    });
    const row = landedRow(database);
    assert.equal(row.status, 'skipped');
    assert.equal(row.error_message, null);
    assert.equal(row.source_language, 'en');
    assert.equal(row.confidence, null);
    assert.equal(calls.detect.mock.callCount(), 1);
    assert.equal(calls.translate.mock.callCount(), 0);
  });

  it('retranslation: provider-established same-language messages remain skipped', async () => {
    const database = client({ confidenceColumns: true, originalLanguage: 'en', detectionSource: 'provider' });
    const calls = provider(null);
    await retranslateForUser(database as unknown as SupabaseClient, RECIPIENT_ID, 'en');
    const row = landedRow(database);
    assert.equal(row.status, 'skipped');
    assert.equal(row.error_message, null);
    assert.equal(row.source_language, 'en');
    assert.equal(row.confidence, null);
    assert.equal(calls.detect.mock.callCount(), 0);
    assert.equal(calls.translate.mock.callCount(), 0);
  });

  it('live: explicitly disabled auto-translation remains skipped, not unavailable', async () => {
    const database = client({ confidenceColumns: true, autoTranslate: false });
    const calls = provider(null);
    await translateMessageForThread(database as unknown as SupabaseClient, {
      messageId: MESSAGE_ID, body: ORIGINAL, senderId: SENDER_ID, threadId: THREAD_ID,
    });
    const row = landedRow(database);
    assert.equal(row.status, 'skipped');
    assert.equal(row.error_message, 'auto_translate_disabled');
    assert.equal(calls.translate.mock.callCount(), 0);
  });

  for (const pipeline of ['live', 'retranslation'] as const) {
    it(`${pipeline}: established different-language messages still translate`, async () => {
      const database = client({ confidenceColumns: true, originalLanguage: 'es', detectionSource: 'provider' });
      const calls = provider('es');
      if (pipeline === 'live') {
        await translateMessageForThread(database as unknown as SupabaseClient, {
          messageId: MESSAGE_ID, body: ORIGINAL, senderId: SENDER_ID, threadId: THREAD_ID,
        });
      } else {
        await retranslateForUser(database as unknown as SupabaseClient, RECIPIENT_ID, 'en');
      }
      const row = landedRow(database);
      assert.equal(row.status, 'translated');
      assert.equal(row.error_message, null);
      assert.equal(row.source_language, 'es');
      assert.equal(row.translated_body, TRANSLATED);
      assert.equal(calls.translate.mock.callCount(), 1);
    });
  }
});
