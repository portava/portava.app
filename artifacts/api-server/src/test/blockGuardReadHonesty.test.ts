import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { isBlockedBetween } from '../lib/blockGuard.js';
import { readPairExclusion } from '../lib/exclusionSet.js';
import { _resetTelegraphMetrics, telegraphSloSnapshot } from '../domain/telegraph/services/telegraphObservability.js';
import { translateMessageForThread, retranslateForUser, __resetConfidenceColumnProbe } from '../services/messageTranslation.js';
import { _setTestTranslationProvider } from '../lib/translation.js';
import { subscribe, type TelegraphEvent } from '../lib/telegraphEvents.js';
import { makeFakeClient } from './telegraphCertificationHarness.js';

const senderId = '11111111-1111-4111-8111-111111111111';
const viewerId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';
const messageId = '44444444-4444-4444-8444-444444444444';
const otherId = '55555555-5555-4555-8555-555555555555';
const body = 'Primera frase https://example.invalid/keep Segunda frase @alice Tercera frase';
const timestamp = '2026-10-01T00:00:00.000Z';
const malformed: Array<[string, unknown]> = [
  ['null', null], ['empty-object', {}], ['row-object', { blocker_id: senderId }],
  ['string', '[]'], ['false', false], ['zero', 0], ['array-like', { length: 0 }],
];

function sdkResponse(value: unknown, status = 200, raw = false) {
  let requests = 0;
  const client = createClient('http://block.fixture.invalid', 'dummy-only', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'http://block.fixture.invalid');
      assert.equal(url.pathname, '/rest/v1/blocks');
      assert.equal(init?.method ?? 'GET', 'GET');
      assert.equal(url.searchParams.get('select'), 'blocker_id');
      assert.equal(url.searchParams.get('limit'), '1');
      assert.equal(url.searchParams.get('or'), `(and(blocker_id.eq.${viewerId},blocked_id.eq.${senderId}),and(blocker_id.eq.${senderId},blocked_id.eq.${viewerId}))`);
      requests += 1;
      let responseBody = status === 204 ? null : JSON.stringify(value);
      if (raw) {
        assert.equal(typeof value, 'string');
        responseBody = value as string;
      }
      return new Response(responseBody, { status, headers: { 'content-type': 'application/json' } });
    } },
  });
  return { client, count: () => requests };
}

function reading(name: string) {
  const result = telegraphSloSnapshot().find(row => row.metric === name);
  assert.ok(result, `Missing metric ${name}`);
  return result;
}

afterEach(() => {
  _setTestTranslationProvider(null);
  __resetConfidenceColumnProbe();
  _resetTelegraphMetrics();
});

const unreadable: Array<[string, unknown]> = [...malformed, ['empty-body', ''], ['no-content', null]];
for (const [label, value] of unreadable) {
  test(`actual SDK ${label} non-list response denies and counts unknown`, async () => {
    const transport = sdkResponse(value, label === 'no-content' ? 204 : 200, label === 'empty-body');
    const answer = await isBlockedBetween(transport.client, viewerId, senderId);
    assert.equal(transport.count(), 1);
    const enforcement = reading('block_enforcement_failures');
    const deliveries = reading('blocked_direct_deliveries');
    assert.deepEqual({ answer, violation: enforcement.violations, unknown: deliveries.unknown, okay: enforcement.ok },
      { answer: true, violation: 1, unknown: 1, okay: 0 });
    assert.equal(deliveries.ok, 0);
  });
}

test('missing data field from a malformed transport denies', async () => {
  const query = { select() { return query; }, or() { return query; }, limit() { return Promise.resolve({ error: null }); } };
  assert.equal(await isBlockedBetween({ from: () => query }, viewerId, senderId), true);
  assert.equal(reading('block_enforcement_failures').violations, 1);
  assert.equal(reading('blocked_direct_deliveries').unknown, 1);
});

for (const [label, value] of malformed) {
  test(`existing readPairExclusion classifies ${label} as unreadable`, async () => {
    const transport = sdkResponse(value);
    assert.equal((await readPairExclusion(transport.client, viewerId, senderId)).ok, false);
    assert.equal(transport.count(), 1);
  });
}

const presenceCases: Array<[string, unknown[], boolean]> = [
  ['known-empty', [], false], ['known-row', [{ blocker_id: senderId }], true], ['nonempty-null-row', [null], true],
];
for (const [label, value, denied] of presenceCases) {
  test(`actual SDK ${label} retains existing presence semantics`, async () => {
    const transport = sdkResponse(value);
    assert.equal(await isBlockedBetween(transport.client, viewerId, senderId), denied);
    assert.equal(transport.count(), 1);
    assert.equal(reading('block_enforcement_failures').ok, 1);
    assert.equal(reading('block_enforcement_failures').violations, 0);
    assert.equal(reading('blocked_direct_deliveries').unknown, 0);
  });
}

const directionalCases: Array<[string, Array<{ blocker_id: string; blocked_id: string }>, boolean]> = [
  ['empty', [], false], ['outbound', [{ blocker_id: viewerId, blocked_id: senderId }], true],
  ['inbound', [{ blocker_id: senderId, blocked_id: viewerId }], true],
  ['mutual', [{ blocker_id: viewerId, blocked_id: senderId }, { blocker_id: senderId, blocked_id: viewerId }], true],
  ['unrelated', [{ blocker_id: otherId, blocked_id: senderId }], false],
];
for (const [label, rows, denied] of directionalCases) {
  test(`actual helper bidirectional ${label} query control`, async () => {
    assert.equal(await isBlockedBetween(makeFakeClient({ blocks: rows }), viewerId, senderId), denied);
  });
}

const absentIdentityCases: Array<[string | null, string | null]> = [['', senderId], [viewerId, ''], [null, senderId], [viewerId, null]];
for (const [userA, userB] of absentIdentityCases) {
  test(`existing absent-identity fast path ${JSON.stringify([userA, userB])} performs no read`, async () => {
    assert.equal(await isBlockedBetween({ from() { assert.fail('unexpected query'); } }, userA as string, userB as string), false);
  });
}

for (const mode of ['returned-error', 'thrown-query', 'invalid-json']) {
  test(`existing ${mode} refusal remains fail closed`, async () => {
    const client = mode === 'returned-error' ? sdkResponse({ code: '42501', message: 'synthetic-denial' }, 403).client
      : mode === 'invalid-json' ? sdkResponse('{', 200, true).client
      : { from() { throw new Error('synthetic-transport-rejection'); } };
    assert.equal(await isBlockedBetween(client, viewerId, senderId), true);
    assert.equal(reading('blocked_direct_deliveries').unknown, 1);
  });
}

function database() {
  return makeFakeClient({
    feature_flags: [], blocks: [],
    profiles: [{ id: viewerId, preferred_language: 'fr', preferred_message_language: 'en', auto_translate_messages: true }],
    message_threads: [{ id: threadId, is_e2ee: false }],
    message_thread_members: [{ thread_id: threadId, user_id: viewerId, left_at: null }],
    messages: [{ id: messageId, thread_id: threadId, sender_id: senderId, body, created_at: timestamp,
      edited_at: null, deleted_at: null, ciphertext: null, unsent_at: null, original_language: 'es', language_detection_source: 'provider' }],
    message_translations: [{ message_id: messageId, recipient_id: viewerId, source_language: 'es', status: 'failed', updated_at: timestamp }],
  });
}

const translationCases: Array<[string, unknown]> = [['known-empty', []], ['null', null], ['row-object', { blocker_id: senderId }]];
for (const stage of ['initial', 'detector', 'fragment', 'fallback', 'sweep']) {
  for (const [label, value] of translationCases) {
    test(`real ${stage} translation with ${label} block response`, async () => {
      const client = database();
      const transport = sdkResponse(value);
      const originalFrom = client.from.bind(client);
      let armed = stage === 'initial' || stage === 'sweep';
      const calls = { detects: 0, fragments: 0, writes: 0 };
      client.from = table => {
        if (table === 'blocks' && armed) return transport.client.from(table);
        const query = originalFrom(table);
        if (table === 'message_translations') {
          const upsert = query.upsert.bind(query);
          query.upsert = async (...args: unknown[]) => {
            calls.writes += 1;
            if (stage === 'fallback' && calls.writes === 1) {
              armed = true;
              return { error: { code: 'PGRST204', message: 'confidence column unavailable' } };
            }
            return await upsert(...args);
          };
        }
        return query;
      };
      _setTestTranslationProvider({
        async detectLanguage() {
          calls.detects += 1;
          if (stage === 'detector') armed = true;
          return { language: 'es', confidence: 'high' };
        },
        async translateText(fragment) {
          calls.fragments += 1;
          if (stage === 'fragment') armed = true;
          return { translatedText: `Traduction ${fragment}`, provider: 'synthetic', providerVersion: 'one' };
        },
      });
      const events: TelegraphEvent[] = [];
      const unsubscribe = subscribe(viewerId, event => { if (event.type === 'message.translated') events.push(event); });
      const translationClient = client as unknown as Parameters<typeof translateMessageForThread>[0];
      try {
        if (stage === 'sweep') await retranslateForUser(translationClient, viewerId, 'fr');
        else await translateMessageForThread(translationClient, { messageId, threadId, senderId, body });
        assert.ok(transport.count() > 0, 'actual helper/installed SDK path was not reached');
        const healthy = label === 'known-empty';
        assert.equal(calls.detects, stage === 'sweep' || (stage === 'initial' && !healthy) ? 0 : 1);
        assert.equal(calls.fragments, healthy || stage === 'fallback' ? 3 : stage === 'fragment' ? 1 : 0);
        assert.equal(calls.writes, healthy ? stage === 'fallback' ? 2 : 1 : stage === 'fallback' ? 1 : 0);
        assert.equal(client._store.messages[0].body, body);
        if (stage !== 'sweep') assert.equal(events.length, healthy ? 1 : 0);
      } finally { unsubscribe(); }
    });
  }
}
