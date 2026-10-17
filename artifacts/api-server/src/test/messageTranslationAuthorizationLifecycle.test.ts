import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { _setTestClient } from '../lib/http.js';
import { _setTestTranslationProvider } from '../lib/translation.js';
import messagingRouter from '../routes/messaging.js';
import { __resetConfidenceColumnProbe, retranslateForUser } from '../services/messageTranslation.js';
import { call, makeFakeClient, startRouter, type RouterHarness } from './telegraphCertificationHarness.js';

const VIEWER = '11111111-1111-4111-8111-111111111111';
const SENDER = '22222222-2222-4222-8222-222222222222';
const THREAD = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const SECOND_MESSAGE = '55555555-5555-4555-8555-555555555555';
const CREATED = '2026-10-01T00:00:00.000Z';
const REJOINED = '2026-10-10T00:00:00.000Z';
const BODY = 'Nos vemos en el muelle a las ocho.';
type Tables = Record<string, any[]>;

function seed(targetLanguage = 'fr'): Tables {
  return {
    feature_flags: [{ flag: 'telegraph_history_bound_enabled', enabled: true }],
    blocks: [],
    profiles: [VIEWER, SENDER].map((id) => ({ id, handle: id, account_status: null, preferred_language: targetLanguage, auto_translate_messages: true })),
    message_threads: [{ id: THREAD, is_e2ee: false, thread_type: 'direct', status: 'active' }],
    message_thread_members: [{
      thread_id: THREAD, user_id: VIEWER, left_at: null, joined_at: REJOINED, visible_from_at: null,
    }],
    messages: [{
      id: MESSAGE, thread_id: THREAD, sender_id: SENDER, body: BODY, created_at: CREATED,
      deleted_at: null, original_language: 'es', language_detection_source: 'provider', msg_type: 'text',
      ciphertext: null, unsent_at: null,
    }],
    message_translations: [{
      message_id: MESSAGE, recipient_id: VIEWER, source_language: 'es', target_language: 'en',
      translated_body: 'Previously translated body.', status: 'translated', updated_at: CREATED,
    }],
  };
}

function provider(duringTranslate?: () => void, outcome: 'valid' | 'invalid' | 'rejected' = 'valid') {
  const translate = mock.fn(async (body: string) => {
    duringTranslate?.();
    if (outcome === 'rejected') throw new Error('offline_provider_failure');
    return {
      translatedText: outcome === 'invalid' ? '' : `[fr] ${body} translated.`,
      provider: 'offline-fixture', providerVersion: 'offline-fixture-1',
    };
  });
  _setTestTranslationProvider({
    detectLanguage: async () => { throw new Error('unexpected_detection'); },
    translateText: translate,
  });
  return translate;
}

function writes(database: ReturnType<typeof makeFakeClient>) {
  return database._observed.upserts.filter((entry) => entry.table === 'message_translations').flatMap((entry) => entry.rows);
}

async function sweep(database: ReturnType<typeof makeFakeClient>, target = 'fr') {
  await retranslateForUser(database as unknown as SupabaseClient, VIEWER, target);
}

let router: RouterHarness;
before(async () => { router = await startRouter(messagingRouter); });
after(async () => { await router.close(); });
beforeEach(() => { __resetConfidenceColumnProbe(); });
afterEach(() => { _setTestTranslationProvider(null); _setTestClient(null, false); });

describe('retranslation does not treat a cached recipient row as current authorization', () => {
  const denied: Array<[string, (tables: Tables) => void]> = [
    ['removed membership', (tables) => { tables.message_thread_members = []; }],
    ['departed membership', (tables) => { tables.message_thread_members[0].left_at = REJOINED; }],
    ['departed member own history', (tables) => {
      tables.message_thread_members[0].left_at = REJOINED;
      tables.messages[0].sender_id = VIEWER;
    }],
    ['another viewer membership', (tables) => { tables.message_thread_members[0].user_id = SENDER; }],
    ['another thread membership', (tables) => { tables.message_thread_members[0].thread_id = MESSAGE; }],
    ['missing membership state', (tables) => { delete tables.message_thread_members[0].left_at; }],
    ['pre-rejoin incoming history', (tables) => { tables.message_thread_members[0].visible_from_at = REJOINED; }],
    ['invalid timestamp even for own history', (tables) => {
      tables.message_thread_members[0].visible_from_at = REJOINED;
      tables.messages[0].created_at = 'invalid';
      tables.messages[0].sender_id = VIEWER;
    }],
    ['deleted source with residual body', (tables) => { tables.messages[0].deleted_at = REJOINED; }],
    ['erased source', (tables) => { tables.messages = []; }],
    ['E2EE thread retaining old plaintext', (tables) => { tables.message_threads[0].is_e2ee = true; }],
    ['missing thread', (tables) => { tables.message_threads = []; }],
    ['unknown E2EE state', (tables) => { tables.message_threads[0].is_e2ee = null; }],
    ['malformed history bound', (tables) => { tables.message_thread_members[0].visible_from_at = {}; }],
  ];
  for (const [label, mutate] of denied) {
    for (const target of ['fr', 'es']) {
      it(`${label}: no provider or cache write for ${target}`, async () => {
        const tables = seed();
        mutate(tables);
        const database = makeFakeClient(tables);
        const translate = provider();
        const originalCache = structuredClone(database._store.message_translations);
        await sweep(database, target);
        assert.equal(translate.mock.callCount(), 0);
        assert.deepEqual(writes(database), []);
        assert.deepEqual(database._store.message_translations, originalCache);
      });
    }
  }

  for (const table of ['messages', 'message_thread_members', 'message_threads']) {
    for (const mode of ['returned error', 'rejected read']) {
      it(`${table} ${mode} refuses processing and writes`, async () => {
        const database = makeFakeClient(seed(), mode === 'returned error'
          ? { errors: { [table]: { message: 'offline_read_failure' } } }
          : { onRead: (name) => { if (name === table) throw new Error('offline_read_failure'); } });
        const translate = provider();
        await sweep(database);
        assert.equal(translate.mock.callCount(), 0);
        assert.deepEqual(writes(database), []);
      });
    }
    for (const shape of ['array', 'primitive']) {
      it(`${table} ${shape} result is not authorization`, async () => {
        const database = makeFakeClient(seed());
        const originalFrom = database.from.bind(database);
        database.from = (name: string) => {
          const query = originalFrom(name);
          if (name === table) query.maybeSingle = async () => ({
            data: shape === 'array' ? database._store[table] : true, error: null,
          });
          return query;
        };
        const translate = provider();
        await sweep(database);
        assert.equal(translate.mock.callCount(), 0);
        assert.deepEqual(writes(database), []);
      });
    }
  }
});

describe('retranslation follows the real thread reader history policy', () => {
  const histories: Array<[string, (tables: Tables) => void, boolean]> = [
    ['pre-window incoming message', (tables) => { tables.message_thread_members[0].visible_from_at = REJOINED; }, false],
    ['own pre-window message', (tables) => {
      tables.message_thread_members[0].visible_from_at = REJOINED;
      tables.messages[0].sender_id = VIEWER;
    }, true],
    ['legacy or explicitly unbounded history', () => {}, true],
    ['inclusive boundary with equivalent timestamp', (tables) => {
      tables.message_thread_members[0].visible_from_at = '2026-10-01T00:00:00+00:00';
    }, true],
    ['history flag OFF', (tables) => {
      tables.feature_flags[0].enabled = false;
      tables.message_thread_members[0].visible_from_at = REJOINED;
    }, true],
    ['blocked sender ordinary retained text', (tables) => {
      tables.blocks = [{ blocker_id: VIEWER, blocked_id: SENDER }];
    }, true],
  ];
  for (const [label, mutate, allowed] of histories) {
    it(label, async () => {
      const tables = seed();
      mutate(tables);
      const database = makeFakeClient(tables);
      _setTestClient(database, true);
      const response = await call(router.base, 'GET', `/threads/${THREAD}/messages`, VIEWER);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.messages.some((message: { id: string }) => message.id === MESSAGE), allowed);
      const translate = provider();
      await sweep(database);
      const translationAllowed = allowed && tables.blocks.length === 0;
      assert.equal(translate.mock.callCount(), translationAllowed ? 1 : 0);
      assert.equal(writes(database).length, translationAllowed ? 1 : 0);
      if (translationAllowed) assert.equal(writes(database)[0].recipient_id, VIEWER);
      if (!tables.feature_flags[0].enabled) {
        assert.ok(database._observed.selects.filter((entry) => entry.table === 'message_thread_members')
          .every((entry) => !entry.sel.includes('visible_from_at')));
      }
    });
  }

  it('keeps the authorized same-language branch without calling the provider', async () => {
    const database = makeFakeClient(seed('es'));
    const translate = provider();
    await sweep(database, 'es');
    assert.equal(translate.mock.callCount(), 0);
    assert.equal(writes(database).length, 1);
    assert.equal(writes(database)[0].status, 'skipped');
  });

  it('rechecks membership before the same-language cache write', async () => {
    let messageReads = 0;
    const database = makeFakeClient(seed('es'), { onRead: (table, store) => {
      if (table === 'messages' && ++messageReads === 2) store.message_thread_members = [];
    } });
    const translate = provider();
    await sweep(database, 'es');
    assert.equal(messageReads, 2);
    assert.equal(translate.mock.callCount(), 0);
    assert.deepEqual(writes(database), []);
  });

  it('withholds a revoked thread without dropping another authorized thread', async () => {
    const tables = seed();
    tables.message_thread_members[0].thread_id = SECOND_MESSAGE;
    tables.message_threads.push({ ...tables.message_threads[0], id: SECOND_MESSAGE });
    tables.messages.push({ ...tables.messages[0], id: SECOND_MESSAGE, thread_id: SECOND_MESSAGE });
    tables.message_translations.push({ ...tables.message_translations[0], message_id: SECOND_MESSAGE });
    const database = makeFakeClient(tables);
    const translate = provider();
    await sweep(database);
    assert.equal(translate.mock.callCount(), 1);
    assert.equal(writes(database).length, 1);
    assert.equal(writes(database)[0].message_id, SECOND_MESSAGE);
    assert.equal(writes(database)[0].recipient_id, VIEWER);
  });

  it('preserves the existing history flag read-error polarity', async () => {
    const tables = seed();
    tables.message_thread_members[0].visible_from_at = REJOINED;
    const database = makeFakeClient(tables, { errors: { feature_flags: { message: 'offline_flag_failure' } } });
    const translate = provider();
    await sweep(database);
    assert.equal(translate.mock.callCount(), 1);
    assert.equal(writes(database).length, 1);
    assert.ok(database._observed.selects.filter((entry) => entry.table === 'message_thread_members')
      .every((entry) => !entry.sel.includes('visible_from_at')));
  });

  it('retains the existing retry when the source remains authorized', async () => {
    const database = makeFakeClient(seed());
    let attempts = 0;
    const translate = provider(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient_provider_failure');
    });
    await sweep(database);
    assert.equal(translate.mock.callCount(), 2);
    assert.equal(writes(database).length, 1);
    assert.equal(writes(database)[0].status, 'translated');
  });
});

describe('authorization and source changes while the provider is pending', () => {
  const mutations: Array<[string, (tables: Tables) => void]> = [
    ['membership removal', (tables) => { tables.message_thread_members = []; }],
    ['window advance', (tables) => { tables.message_thread_members[0].visible_from_at = REJOINED; }],
    ['E2EE enablement', (tables) => { tables.message_threads[0].is_e2ee = true; }],
    ['source erasure', (tables) => { tables.messages = []; }],
    ['source deletion', (tables) => { tables.messages[0].deleted_at = REJOINED; }],
    ['source edit', (tables) => { tables.messages[0].body = 'New message, not the text the provider received.'; }],
  ];
  for (const [label, mutate] of mutations) {
    it(`${label} prevents the stale result from being persisted`, async () => {
      const database = makeFakeClient(seed());
      const translate = provider(() => mutate(database._store));
      await sweep(database);
      assert.equal(translate.mock.callCount(), 1);
      assert.deepEqual(writes(database), []);
    });
  }
  for (const outcome of ['invalid', 'rejected'] as const) {
    it(`revocation also suppresses the ${outcome} provider failure row`, async () => {
      const database = makeFakeClient(seed());
      const translate = provider(() => { database._store.message_thread_members = []; }, outcome);
      await sweep(database);
      assert.equal(translate.mock.callCount(), 1);
      assert.deepEqual(writes(database), []);
    });
  }
  for (const table of ['messages', 'message_thread_members', 'message_threads']) {
    it(`${table} becoming unreadable while translating prevents a cache write`, async () => {
      let providerStarted = false;
      const database = makeFakeClient(seed(), { onRead: (name) => {
        if (providerStarted && name === table) throw new Error('offline_recheck_failure');
      } });
      const translate = provider(() => { providerStarted = true; });
      await sweep(database);
      assert.equal(translate.mock.callCount(), 1);
      assert.deepEqual(writes(database), []);
    });
  }
  it('does not reuse authorization for a later message in the same sweep', async () => {
    const tables = seed();
    tables.messages.push({ ...tables.messages[0], id: SECOND_MESSAGE });
    tables.message_translations.push({ ...tables.message_translations[0], message_id: SECOND_MESSAGE });
    const database = makeFakeClient(tables);
    const translate = provider(() => { database._store.message_thread_members = []; });
    await sweep(database);
    assert.equal(translate.mock.callCount(), 1);
    assert.deepEqual(writes(database), []);
  });
});
