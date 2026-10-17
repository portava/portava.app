import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { _setTestClient } from '../lib/http.js';
import { _setTestTranslationProvider } from '../lib/translation.js';
import groupChatRouter from '../routes/groupChat.js';
import {
  __resetConfidenceColumnProbe,
  retranslateForUser,
  translateMessageForThread,
} from '../services/messageTranslation.js';
import { KIND_ENVELOPE_VERSION } from '../services/telegraph/messageKinds.js';
import { validateVoicePayload, voiceMessageRow } from '../services/telegraph/voice.js';
import { call, makeFakeClient, resetFakeIds, startRouter, type RouterHarness } from './telegraphCertificationHarness.js';

const SENDER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const RECIPIENT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const OTHER_RECIPIENT_ID = 'cccccccc-0000-4000-8000-000000000003';
const THREAD_ID = 'dddddddd-0000-4000-8000-000000000004';
const MESSAGE_ID = 'eeeeeeee-0000-4000-8000-000000000005';
const PROSE_MESSAGE_ID = 'ffffffff-0000-4000-8000-000000000006';
const CREATED_AT = '2026-10-01T00:00:00.000Z';
const ORIGINAL = 'Nos vemos en el muelle a las ocho.';
const STORAGE_KEY = `post-media/${SENDER_ID}/voice/private-recording.m4a`;

function voiceBody(): string {
  const payload = validateVoicePayload({
    url: STORAGE_KEY, durationSeconds: 12, waveform: [], mimeType: 'audio/mp4',
  });
  assert.equal(payload.ok, true);
  if (!payload.ok) throw new Error('invalid voice fixture');
  return String(voiceMessageRow({
    threadId: THREAD_ID, senderId: SENDER_ID, payload: payload.payload, createdAt: CREATED_AT,
  }).body);
}

function message(body: string, messageId = MESSAGE_ID) {
  return {
    id: messageId, thread_id: THREAD_ID, sender_id: SENDER_ID, body,
    created_at: CREATED_AT, deleted_at: null, edited_at: null,
    ciphertext: null,
    original_language: 'es', language_detection_source: 'provider', msg_type: 'text',
  };
}

function translation(recipientId = RECIPIENT_ID, messageId = MESSAGE_ID) {
  return {
    message_id: messageId, recipient_id: recipientId, source_language: 'es', target_language: 'en',
    translated_body: 'The previous prose translation.', status: 'translated', updated_at: CREATED_AT,
  };
}

function seed(body = ORIGINAL) {
  return {
    feature_flags: [], blocks: [],
    profiles: [SENDER_ID, RECIPIENT_ID, OTHER_RECIPIENT_ID].map((userId) => ({
      id: userId, handle: userId, account_status: null, preferred_language: 'en', auto_translate_messages: true,
    })),
    message_threads: [{ id: THREAD_ID, thread_type: 'direct', status: 'active', is_e2ee: false }],
    message_thread_members: [SENDER_ID, RECIPIENT_ID, OTHER_RECIPIENT_ID].map((userId) => ({
      thread_id: THREAD_ID, user_id: userId, role: 'member', left_at: null, visible_from_at: null,
    })),
    messages: [message(body)],
    message_translations: [translation(), translation(OTHER_RECIPIENT_ID)],
  };
}

function provider() {
  const detect = mock.fn(async (_text: string) => ({ language: 'es', confidence: 'high' as const }));
  const translate = mock.fn(async (text: string, _source: string, target: string) => ({
    translatedText: `[${target}] ${text} translated.`, provider: 'offline-fixture', providerVersion: 'offline-fixture-1',
  }));
  _setTestTranslationProvider({ detectLanguage: detect, translateText: translate });
  return { detect, translate };
}

let router: RouterHarness;
before(async () => { router = await startRouter(groupChatRouter); });
after(async () => { await router.close(); });
beforeEach(() => { resetFakeIds(); __resetConfidenceColumnProbe(); });
afterEach(() => { _setTestTranslationProvider(null); _setTestClient(null, false); });

describe('message translation cache lifecycle — structured bodies stay out of the preference sweep', () => {
  it('an authorized edit can leave a pending cache row, but changing language must not send the new voice envelope to the provider', async () => {
    const database = makeFakeClient(seed());
    _setTestClient(database, true);
    const observed = provider();
    const body = voiceBody();

    const response = await call(router.base, 'PATCH', `/messages/${MESSAGE_ID}`, SENDER_ID, { body });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(database._store.messages[0].body, body);
    assert.ok(database._store.message_translations.every((row) => row.status === 'pending' && row.translated_body === null));
    assert.equal(observed.detect.mock.callCount(), 0);
    assert.equal(observed.translate.mock.callCount(), 0);
    const beforeSweep = structuredClone(database._store.message_translations);

    await retranslateForUser(database as unknown as SupabaseClient, RECIPIENT_ID, 'fr');

    assert.deepEqual(observed.translate.mock.calls.map((entry) => entry.arguments[0]), []);
    assert.deepEqual(database._store.message_translations, beforeSweep);
    assert.ok(!JSON.stringify(database._store.message_translations).includes(STORAGE_KEY));
  });

  for (const kind of ['VOICE', 'LOCATION', 'FUTURE_STRUCTURED_KIND']) {
    for (const target of ['es', 'fr']) {
      it(`${kind} is refused before either the same-language or provider branch for ${target}`, async () => {
        const body = JSON.stringify({ kind, envelopeVersion: KIND_ENVELOPE_VERSION, payload: { privateKey: STORAGE_KEY } });
        const tables = seed(body);
        tables.message_translations = tables.message_translations.map((row) => ({ ...row, status: 'pending', translated_body: '' }));
        const database = makeFakeClient(tables);
        const observed = provider();
        const beforeSweep = structuredClone(database._store.message_translations);

        await translateMessageForThread(database as unknown as SupabaseClient, {
          messageId: MESSAGE_ID, body, senderId: SENDER_ID, threadId: THREAD_ID,
        });
        await retranslateForUser(database as unknown as SupabaseClient, RECIPIENT_ID, target);

        assert.equal(observed.detect.mock.callCount(), 0);
        assert.equal(observed.translate.mock.callCount(), 0);
        assert.deepEqual(database._store.message_translations, beforeSweep);
      });
    }
  }

  it('skips only the structured row while translating prose for the selected recipient', async () => {
    const tables = seed(voiceBody());
    tables.profiles.find(profile => profile.id === RECIPIENT_ID)!.preferred_language = 'fr';
    tables.messages.push(message(ORIGINAL, PROSE_MESSAGE_ID));
    tables.message_translations.push(translation(RECIPIENT_ID, PROSE_MESSAGE_ID), translation(OTHER_RECIPIENT_ID, PROSE_MESSAGE_ID));
    const database = makeFakeClient(tables);
    const observed = provider();
    const untouched = structuredClone(database._store.message_translations.filter((row) => row.message_id === MESSAGE_ID || row.recipient_id === OTHER_RECIPIENT_ID));

    await retranslateForUser(database as unknown as SupabaseClient, RECIPIENT_ID, 'fr');

    assert.deepEqual(observed.translate.mock.calls.map((entry) => entry.arguments[0]), [ORIGINAL]);
    assert.deepEqual(database._store.message_translations.filter((row) => row.message_id === MESSAGE_ID || row.recipient_id === OTHER_RECIPIENT_ID), untouched);
    const writes = database._observed.upserts.filter((entry) => entry.table === 'message_translations').flatMap((entry) => entry.rows);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].message_id, PROSE_MESSAGE_ID);
    assert.equal(writes[0].recipient_id, RECIPIENT_ID);
    assert.equal(writes[0].status, 'translated');
    assert.equal(writes[0].target_language, 'fr');
  });

  for (const body of [ORIGINAL, 'The words kind and envelopeVersion are ordinary prose.', '{"kind":"VOICE"}', '{"kind":"VOICE","envelopeVersion":"other"}']) {
    it(`preserves the existing prose boundary for ${body}`, async () => {
      const database = makeFakeClient(seed(body));
      database._store.profiles.find(profile => profile.id === RECIPIENT_ID)!.preferred_language = 'fr';
      const observed = provider();
      await retranslateForUser(database as unknown as SupabaseClient, RECIPIENT_ID, 'fr');
      assert.deepEqual(observed.translate.mock.calls.map((entry) => entry.arguments[0]), [body]);
      const writes = database._observed.upserts.filter((entry) => entry.table === 'message_translations').flatMap((entry) => entry.rows);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].recipient_id, RECIPIENT_ID);
      assert.equal(writes[0].status, 'translated');
      assert.equal(writes[0].target_language, 'fr');
      assert.equal(writes[0].translated_body, `[fr] ${body} translated.`);
    });
  }

  it('does not send the cleared body of a deleted message to the provider', async () => {
    const database = makeFakeClient(seed());
    _setTestClient(database, true);
    const observed = provider();
    const response = await call(router.base, 'DELETE', `/messages/${MESSAGE_ID}`, SENDER_ID);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(database._store.messages[0].body, '');
    await retranslateForUser(database as unknown as SupabaseClient, RECIPIENT_ID, 'fr');
    assert.equal(observed.translate.mock.callCount(), 0);
  });
});
