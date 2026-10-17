import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { _setTestTranslationProvider, TRANSLATION_TIMEOUT_MS, translatePreservingEntities, type TranslationProvider } from '../lib/translation.js';
import { __resetConfidenceColumnProbe, retranslateForUser } from '../services/messageTranslation.js';
import { makeFakeClient } from './telegraphCertificationHarness.js';

const viewerId = '11111111-1111-4111-8111-111111111111';
const senderId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';
const messageId = '44444444-4444-4444-8444-444444444444';
const timestamp = '2026-10-01T00:00:00Z';
const originalBody = 'Primera frase https://example.invalid/private Segunda frase @alice Tercera frase';

function database(body = originalBody, target = 'fr') {
  return makeFakeClient({
    feature_flags: [], blocks: [],
    profiles: [{ id: viewerId, preferred_language: target, auto_translate_messages: true }],
    message_threads: [{ id: threadId, is_e2ee: false }],
    message_thread_members: [{ thread_id: threadId, user_id: viewerId, left_at: null }],
    messages: [{ id: messageId, thread_id: threadId, sender_id: senderId, body, created_at: timestamp,
      edited_at: null, deleted_at: null, ciphertext: null, unsent_at: null,
      original_language: 'es', language_detection_source: 'provider' }],
    message_translations: [{ message_id: messageId, recipient_id: viewerId, source_language: 'es',
      target_language: 'en', translated_body: 'Old translation', status: 'translated', updated_at: timestamp }],
  });
}

type FixtureDatabase = ReturnType<typeof database>;

function retranslateFixture(client: FixtureDatabase, target = 'fr') {
  return retranslateForUser(client as unknown as Parameters<typeof retranslateForUser>[0], viewerId, target);
}

function writtenRows(client: FixtureDatabase) {
  return client._observed.upserts.filter(entry => entry.table === 'message_translations').flatMap(entry => entry.rows);
}

function translationProvider(afterDispatch: (count: number) => void = () => {}) {
  const calls: string[] = [];
  const provider: TranslationProvider = {
    async detectLanguage() { throw new Error('unexpected_detection'); },
    async translateText(body) {
      calls.push(body);
      afterDispatch(calls.length);
      return { translatedText: `Traduction ${body}`, provider: 'synthetic-only', providerVersion: 'one' };
    },
  };
  _setTestTranslationProvider(provider);
  return { calls, provider };
}

const revocations: Array<[string, (client: FixtureDatabase) => void]> = [
  ['block', client => { client._store.blocks.push({ blocker_id: viewerId, blocked_id: senderId }); }],
  ['membership', client => { client._store.message_thread_members = []; }],
  ['deleted source', client => { client._store.messages[0].deleted_at = timestamp; }],
  ['preference', client => { client._store.profiles[0].auto_translate_messages = false; }],
  ['edited source', client => { client._store.messages[0].body = 'Texto distinto'; }],
];

beforeEach(() => __resetConfidenceColumnProbe());
afterEach(() => _setTestTranslationProvider(null));

for (const [label, revoke] of revocations) {
  test(`${label} after the first fragment prevents subsequent provider dispatch and publication`, async () => {
    const client = database();
    const { calls } = translationProvider(count => { if (count === 1) revoke(client); });
    await retranslateFixture(client);
    assert.deepEqual(calls, ['Primera frase']);
    assert.deepEqual(writtenRows(client), []);
  });
}

test('authorized fragments preserve navigation entities, original content and one recipient write', async () => {
  const client = database();
  const { calls } = translationProvider();
  await retranslateFixture(client);
  assert.deepEqual(calls, ['Primera frase', 'Segunda frase', 'Tercera frase']);
  const rows = writtenRows(client);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipient_id, viewerId);
  assert.match(rows[0].translated_body, /https:\/\/example\.invalid\/private/);
  assert.match(rows[0].translated_body, /@alice/);
  assert.equal(client._store.messages[0].body, originalBody);
});

for (const outcome of ['translated', 'same-language', 'invalid'] as const) {
  for (const revoked of [true, false]) {
    test(`compatibility retry for ${outcome} ${revoked ? 'refuses revoked ownership' : 'preserves healthy fallback'}`, async () => {
      const target = outcome === 'same-language' ? 'es' : 'fr';
      const client = database('Un mensaje sin entidades', target);
      if (outcome === 'invalid') {
        _setTestTranslationProvider({
          async detectLanguage() { throw new Error('unexpected_detection'); },
          async translateText() { return { translatedText: '', provider: 'synthetic-only', providerVersion: 'one' }; },
        });
      } else translationProvider();
      const attempts: Array<Record<string, unknown>> = [];
      const originalFrom = client.from.bind(client);
      client.from = (table: string) => {
        const query = originalFrom(table);
        if (table === 'message_translations') query.upsert = async (row: Record<string, unknown>) => {
          attempts.push(row);
          if (attempts.length === 1) {
            if (revoked) client._store.message_thread_members = [];
            return { error: { code: 'PGRST204', message: 'Missing confidence column' } };
          }
          return { error: null };
        };
        return query;
      };
      await retranslateFixture(client, target);
      assert.equal(attempts.length, revoked ? 1 : 2);
      assert.equal('confidence' in attempts[0], true);
      if (!revoked) assert.equal('confidence' in attempts[1], false);
      assert.equal(attempts[0].status, outcome === 'same-language' ? 'skipped' : outcome === 'invalid' ? 'failed' : 'translated');
    });
  }
}

test('an asynchronous dispatch guard can refuse the first provider call', async () => {
  const { provider, calls } = translationProvider();
  let finishGuard!: (allowed: boolean) => void;
  const pending = translatePreservingEntities(provider, originalBody, 'es', 'fr',
    () => new Promise<boolean>(resolve => { finishGuard = resolve; }));
  assert.deepEqual(calls, []);
  finishGuard(false);
  await assert.rejects(pending, /translation_source_unavailable/);
  assert.deepEqual(calls, []);
});

test('dispatch-guard failure cannot become provider input or a silent authorization grant', async () => {
  const { provider, calls } = translationProvider();
  await assert.rejects(translatePreservingEntities(provider, originalBody, 'es', 'fr', async () => {
    throw new Error('authorization_unreadable');
  }), /authorization_unreadable/);
  assert.deepEqual(calls, []);
});

test('callers without a guard retain entity-preserving translation', async () => {
  const { provider, calls } = translationProvider();
  const result = await translatePreservingEntities(provider, originalBody, 'es', 'fr');
  assert.equal(calls.length, 3);
  assert.equal(result.providerVersion, 'one');
  assert.match(result.translatedText, /@alice/);
});

test('authorization finishing after the fragment deadline cannot dispatch stale work', async () => {
  const { provider, calls } = translationProvider();
  const originalNow = Date.now;
  const start = originalNow();
  let currentTime = start;
  Date.now = () => currentTime;
  try {
    await assert.rejects(translatePreservingEntities(provider, originalBody, 'es', 'fr', async () => {
      currentTime = start + TRANSLATION_TIMEOUT_MS;
      return true;
    }), /translation_timeout/);
    assert.deepEqual(calls, []);
  } finally {
    Date.now = originalNow;
  }
});
