import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { _setTestTranslationProvider, type TranslationProvider } from '../lib/translation.js';
import { subscribe, type TelegraphEvent } from '../lib/telegraphEvents.js';
import { __resetConfidenceColumnProbe, translateMessageForThread } from '../services/messageTranslation.js';
import { makeFakeClient, type FakeDbOptions } from './telegraphCertificationHarness.js';
import { makeSchemaStrictClient } from './helpers/schemaStrictSupabase.js';
import { makeFailClosedClient } from './helpers/failClosedSupabase.js';

const senderId = '11111111-1111-4111-8111-111111111111';
const recipientId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';
const messageId = '44444444-4444-4444-8444-444444444444';
const otherId = '55555555-5555-4555-8555-555555555555';
const timestamp = '2026-10-01T00:00:00.000Z';
const later = '2026-10-16T00:00:00.000Z';
const body = 'Primera frase https://example.invalid/keep Segunda frase @alice Tercera frase';

function seed() {
  return {
    feature_flags: [] as Array<{ flag: string; enabled: boolean }>, blocks: [],
    profiles: [{ id: recipientId, preferred_language: 'fr', preferred_message_language: 'en', auto_translate_messages: true }],
    message_threads: [{ id: threadId, is_e2ee: false }],
    message_thread_members: [{ thread_id: threadId, user_id: recipientId, left_at: null, visible_from_at: null }],
    messages: [{ id: messageId, thread_id: threadId, sender_id: senderId, body, created_at: timestamp,
      edited_at: null, deleted_at: null, ciphertext: null, unsent_at: null,
      original_language: null, language_detection_source: null }],
    message_translations: [],
  };
}

function database(options?: FakeDbOptions) { return makeFakeClient(seed(), options); }
type Database = ReturnType<typeof database>;

function run(client: Database | SupabaseClient, overrides: Partial<Parameters<typeof translateMessageForThread>[1]> = {}) {
  return translateMessageForThread(client as unknown as SupabaseClient, { messageId, senderId, threadId, body, ...overrides });
}

function provider(hooks: {
  detect?: (count: number) => void | Promise<void>;
  translate?: (count: number) => void | Promise<void>;
  language?: string;
  invalid?: boolean;
} = {}) {
  const observed = { detects: 0, fragments: [] as string[] };
  const implementation: TranslationProvider = {
    async detectLanguage() {
      observed.detects += 1;
      await hooks.detect?.(observed.detects);
      return { language: hooks.language ?? 'es', confidence: 'high' };
    },
    async translateText(fragment) {
      observed.fragments.push(fragment);
      await hooks.translate?.(observed.fragments.length);
      return { translatedText: hooks.invalid ? fragment : `Traduction ${fragment}`, provider: 'synthetic-only', providerVersion: 'one' };
    },
  };
  _setTestTranslationProvider(implementation);
  return observed;
}

function writes(client: Database) { return client._observed.upserts.filter(entry => entry.table === 'message_translations'); }
function stamps(client: Database) { return client._observed.updates.filter(entry => entry.table === 'messages'); }

const revocations: Array<[string, (client: Database) => void]> = [
  ['block', client => { client._store.blocks.push({ blocker_id: recipientId, blocked_id: senderId }); }],
  ['reverse block', client => { client._store.blocks.push({ blocker_id: senderId, blocked_id: recipientId }); }],
  ['removed membership', client => { client._store.message_thread_members = []; }],
  ['departed membership', client => { client._store.message_thread_members[0].left_at = later; }],
  ['deleted source', client => { client._store.messages[0].deleted_at = later; }],
  ['erased source', client => { client._store.messages = []; }],
  ['opt-out', client => { client._store.profiles[0].auto_translate_messages = false; }],
  ['target change', client => { client._store.profiles[0].preferred_language = 'de'; }],
  ['body edit', client => { client._store.messages[0].body = 'Different authored body'; }],
  ['edit revision', client => { client._store.messages[0].edited_at = later; }],
  ['author change', client => { client._store.messages[0].sender_id = otherId; }],
  ['thread change', client => { client._store.messages[0].thread_id = otherId; }],
  ['encrypted thread', client => { client._store.message_threads[0].is_e2ee = true; }],
  ['ciphertext', client => { client._store.messages[0].ciphertext = 'encrypted'; }],
  ['history narrowing', client => {
    client._store.feature_flags = [{ flag: 'telegraph_history_bound_enabled', enabled: true }];
    client._store.message_thread_members[0].visible_from_at = later;
  }],
  ['kernel unsend', client => {
    client._store.feature_flags = [{ flag: 'telegraph_message_kernel_enabled', enabled: true }];
    client._store.messages[0].unsent_at = later;
  }],
];

beforeEach(() => __resetConfidenceColumnProbe());
afterEach(() => _setTestTranslationProvider(null));

for (const [label, revoke] of revocations) {
  for (const fragment of [1, 3]) {
    test(`${label} after fragment ${fragment} stops all later dispatch/write/publication`, async () => {
      const client = database();
      const events: TelegraphEvent[] = [];
      const unsubscribe = subscribe(recipientId, event => events.push(event));
      try {
        const observed = provider({ translate: count => { if (count === fragment) revoke(client); } });
        await run(client);
        assert.equal(observed.fragments.length, fragment);
        assert.deepEqual(writes(client), []);
        assert.deepEqual(events, []);
      } finally { unsubscribe(); }
    });
  }
}

for (const [label, revoke] of revocations.filter(([label]) => !['opt-out', 'target change'].includes(label))) {
  test(`${label} during detection prevents stale stamping and translation`, async () => {
    const client = database();
    const observed = provider({ detect: () => revoke(client) });
    await run(client);
    assert.equal(observed.detects, 1);
    assert.deepEqual(observed.fragments, []);
    assert.deepEqual(stamps(client), []);
    assert.deepEqual(writes(client), []);
  });
}

test('failed detector cannot retry on revoked authority', async () => {
  const client = database();
  const observed = provider({ detect: () => { revocations[0][1](client); throw new Error('synthetic_detector_failure'); } });
  await run(client);
  assert.equal(observed.detects, 1);
  assert.deepEqual(observed.fragments, []);
  assert.deepEqual(stamps(client), []);
  assert.deepEqual(writes(client), []);
});

test('failed translation cannot retry or record failure on revoked authority', async () => {
  const client = database();
  const observed = provider({ translate: () => { revocations[0][1](client); throw new Error('synthetic_provider_failure'); } });
  await run(client);
  assert.equal(observed.fragments.length, 1);
  assert.deepEqual(writes(client), []);
});

for (const [label, mutate] of [
  ['E2EE', (client: Database) => { client._store.message_threads[0].is_e2ee = true; }],
  ['missing thread', (client: Database) => { client._store.message_threads = []; }],
  ['ciphertext', (client: Database) => { client._store.messages[0].ciphertext = 'encrypted'; }],
  ['departed', (client: Database) => { client._store.message_thread_members[0].left_at = later; }],
  ['missing profile', (client: Database) => { client._store.profiles = []; }],
  ['unknown consent', (client: Database) => { client._store.profiles[0].auto_translate_messages = null; }],
] as const) {
  test(`initial ${label} does not dispatch detection or translation`, async () => {
    const client = database();
    mutate(client);
    const observed = provider();
    await run(client);
    assert.equal(observed.detects, 0);
    assert.deepEqual(observed.fragments, []);
    assert.ok(writes(client).every(entry => entry.rows.every(row => row.translated_body === null && row.status === 'failed')));
  });
}

for (const override of [{ body: 'wrong queued body' }, { senderId: otherId }, { threadId: otherId }]) {
  test(`caller ${Object.keys(override)[0]} mismatch is not authored authority`, async () => {
    const client = database();
    const observed = provider();
    await run(client, override);
    assert.equal(observed.detects, 0);
    assert.deepEqual(writes(client), []);
    assert.deepEqual(stamps(client), []);
  });
}

for (const table of ['messages', 'message_threads', 'message_thread_members', 'blocks']) {
  for (const mode of ['returned', 'thrown']) {
    test(`initial ${table} ${mode} error refuses provider and writes`, async () => {
      const client = database(mode === 'returned'
        ? { errors: { [table]: { code: '57P01', message: 'synthetic_unread' } } }
        : { onRead: name => { if (name === table) throw new Error('synthetic_unread'); } });
      const observed = provider();
      await run(client);
      assert.equal(observed.detects, 0);
      assert.deepEqual(writes(client), []);
    });
  }
}

for (const mode of ['unread', 'off', 'verified match', 'assumed match', 'legacy target', 'healthy'] as const) {
  test(`${mode} keeps honest status, target, source provenance and original`, async () => {
    const client = database(mode === 'unread' ? { errors: { profiles: { code: '57P01', message: 'synthetic_unread' } } } : undefined);
    if (mode === 'off') client._store.profiles[0].auto_translate_messages = false;
    if (mode === 'legacy target') {
      client._store.profiles[0].preferred_language = null;
      client._store.profiles[0].preferred_message_language = 'fr';
    }
    const observed = provider({ language: mode.endsWith('match') ? 'fr' : 'es', detect: () => {
      if (mode === 'assumed match') throw new Error('synthetic_detector_failure');
    } });
    const events: TelegraphEvent[] = [];
    const unsubscribe = subscribe(recipientId, event => events.push(event));
    try {
      await run(client, mode === 'assumed match' ? { senderPreferredLanguage: 'fr' } : {});
      assert.equal(client._store.messages[0].body, body);
      assert.equal(writes(client).length, 1);
      const row = writes(client)[0].rows[0];
      assert.equal(row.confidence, null);
      assert.equal(row.target_language, mode === 'unread' ? 'und' : 'fr');
      const translated = mode === 'healthy' || mode === 'legacy target';
      assert.equal(row.status, translated ? 'translated' : mode === 'off' || mode === 'verified match' ? 'skipped' : 'failed');
      assert.equal(observed.detects, mode === 'unread' || mode === 'off' ? 0 : mode === 'assumed match' ? 2 : 1);
      assert.equal(observed.fragments.length, translated ? 3 : 0);
      assert.equal(events.length, translated ? 1 : 0);
      if (translated) {
        assert.equal(row.provider_version, 'one');
        assert.match(row.translated_body, /https:\/\/example\.invalid\/keep/);
        assert.match(row.translated_body, /@alice/);
        assert.equal(client._store.messages[0].language_detection_source, 'provider');
      }
      if (mode === 'unread') assert.equal(row.error_message, 'recipient_preferences_unreadable');
      if (mode === 'off') assert.equal(row.error_message, 'auto_translate_disabled');
      if (mode === 'assumed match') {
        assert.equal(row.source_language, 'und');
        assert.equal(row.error_message, 'source_language_unverified');
        assert.equal(client._store.messages[0].language_detection_source, 'sender_preference');
      }
    } finally { unsubscribe(); }
  });
}

for (const outcome of ['translated', 'same', 'off', 'unread', 'invalid', 'provider-failed'] as const) {
  for (const revoke of [false, true]) {
    test(`${outcome} schema fallback ${revoke ? 'withholds revoked retry' : 'stores healthy result'}`, async () => {
      const client = database(outcome === 'unread' ? { errors: { profiles: { message: 'synthetic_unread' } } } : undefined);
      if (outcome === 'off') client._store.profiles[0].auto_translate_messages = false;
      provider({ language: outcome === 'same' ? 'fr' : 'es', invalid: outcome === 'invalid', translate: () => {
        if (outcome === 'provider-failed') throw new Error('synthetic_provider_failure');
      } });
      const originalFrom = client.from.bind(client);
      const attempts: Array<Record<string, unknown>> = [];
      client.from = table => {
        const query = originalFrom(table);
        if (table === 'message_translations') query.upsert = async (row: Record<string, unknown>) => {
          attempts.push(row);
          if (attempts.length === 1) {
            if (revoke) revocations[0][1](client);
            return { error: { code: 'PGRST204', message: 'confidence column unavailable' } };
          }
          return { error: null };
        };
        return query;
      };
      await run(client);
      assert.equal(attempts.length, revoke ? 1 : 2);
      assert.equal('confidence' in attempts[0], true);
      if (!revoke) assert.equal('confidence' in attempts[1], false);
      assert.equal(attempts[0].status, outcome === 'translated' ? 'translated' : ['same', 'off'].includes(outcome) ? 'skipped' : 'failed');
    });
  }
}

for (const mode of ['write-error', 'revoked-after-write'] as const) {
  test(`${mode} cannot publish a successful translation`, async () => {
    const client = database(mode === 'write-error' ? { errors: {
      message_translations: { code: '42501', message: 'synthetic_write_denied', ops: ['upsert'] },
    } } : undefined);
    if (mode === 'revoked-after-write') {
      const originalFrom = client.from.bind(client);
      client.from = table => {
        const query = originalFrom(table);
        if (table === 'message_translations') {
          const upsert = query.upsert.bind(query);
          query.upsert = async (...args: unknown[]) => {
            const result = await upsert(...args);
            revocations[0][1](client);
            return result;
          };
        }
        return query;
      };
    }
    const events: TelegraphEvent[] = [];
    const unsubscribe = subscribe(recipientId, event => events.push(event));
    try {
      provider();
      await run(client);
      assert.deepEqual(events, []);
      assert.equal(client._store.message_translations.length, mode === 'write-error' ? 0 : 1);
    } finally { unsubscribe(); }
  });
}

test('one revoked recipient cannot suppress a separate current recipient', async () => {
  const client = database();
  client._store.profiles.push({ ...client._store.profiles[0], id: otherId });
  client._store.message_thread_members.push({ ...client._store.message_thread_members[0], user_id: otherId });
  const observed = provider({ translate: count => { if (count === 1) revocations[0][1](client); } });
  await run(client);
  assert.equal(observed.fragments.length, 4);
  assert.equal(writes(client).length, 1);
  assert.equal(writes(client)[0].rows[0].recipient_id, otherId);
});

for (const mode of ['no recipients', 'unread roster', 'malformed roster', 'missing creation time'] as const) {
  test(`${mode} does not dispatch or stamp`, async () => {
    const client = database();
    if (mode === 'no recipients') client._store.message_thread_members = [];
    if (mode === 'missing creation time') delete client._store.messages[0].created_at;
    if (mode === 'unread roster' || mode === 'malformed roster') {
      const originalFrom = client.from.bind(client);
      client.from = table => {
        const query = originalFrom(table);
        if (table === 'message_thread_members') query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({
          data: mode === 'unread roster' ? null : [{ user_id: null }], error: null,
        }).then(resolve);
        return query;
      };
    }
    const observed = provider();
    await run(client);
    assert.equal(observed.detects, 0);
    assert.deepEqual(writes(client), []);
    assert.deepEqual(stamps(client), []);
  });
}

for (const mode of ['returned error', 'thrown error', 'zero affected', 'revision changed before stamp'] as const) {
  test(`${mode} metadata update cannot authorize a derivative`, async () => {
    const client = database();
    const originalFrom = client.from.bind(client);
    client.from = table => {
      const query = originalFrom(table);
      if (table === 'messages') {
        const update = query.update.bind(query);
        query.update = (payload: Record<string, unknown>) => {
          const chain = update(payload);
          const single = chain.maybeSingle.bind(chain);
          chain.maybeSingle = async () => {
            if (mode === 'thrown error') throw new Error('synthetic_stamp_error');
            if (mode === 'returned error') return { data: null, error: { code: '42501', message: 'synthetic_stamp_error' } };
            if (mode === 'zero affected') return { data: null, error: null };
            client._store.messages[0].body = 'Replacement authored text';
            client._store.messages[0].edited_at = later;
            return single();
          };
          return chain;
        };
      }
      return query;
    };
    const observed = provider();
    await run(client);
    assert.equal(observed.detects, 1);
    assert.deepEqual(observed.fragments, []);
    assert.deepEqual(writes(client), []);
    assert.equal(client._store.messages[0].original_language, null);
    assert.equal(client._store.messages[0].language_detection_source, null);
  });
}

for (const mode of ['off to on', 'unread to known', 'enabled target change'] as const) {
  test(`${mode} during stamp cannot write a stale outcome`, async () => {
    const client = database();
    if (mode === 'off to on') client._store.profiles[0].auto_translate_messages = false;
    if (mode === 'unread to known') client._store.profiles[0].auto_translate_messages = null;
    const originalFrom = client.from.bind(client);
    client.from = table => {
      const query = originalFrom(table);
      if (table === 'messages') {
        const update = query.update.bind(query);
        query.update = (payload: Record<string, unknown>) => {
          const chain = update(payload);
          const single = chain.maybeSingle.bind(chain);
          chain.maybeSingle = async () => {
            const result = await single();
            client._store.profiles[0].auto_translate_messages = true;
            if (mode === 'enabled target change') client._store.profiles[0].preferred_language = 'de';
            return result;
          };
          return chain;
        };
      }
      return query;
    };
    const observed = provider();
    await run(client);
    assert.deepEqual(writes(client), []);
    assert.deepEqual(observed.fragments, []);
  });
}

test('cached legacy schema branch still reauthorizes before the next recipient write', async () => {
  const warm = database();
  const warmFrom = warm.from.bind(warm);
  let attempts = 0;
  warm.from = table => {
    const query = warmFrom(table);
    if (table === 'message_translations') query.upsert = async () => ({
      error: ++attempts === 1 ? { code: 'PGRST204', message: 'confidence column unavailable' } : null,
    });
    return query;
  };
  provider();
  await run(warm);
  assert.equal(attempts, 2);
  const client = database();
  const observed = provider({ translate: count => { if (count === 3) revocations[0][1](client); } });
  await run(client);
  assert.equal(observed.fragments.length, 3);
  assert.deepEqual(writes(client), []);
});

for (const stage of ['detector', 'translation'] as const) {
  test(`healthy ${stage} retry keeps the original budget and actual provenance`, async () => {
    const client = database();
    const observed = provider({
      detect: count => { if (stage === 'detector' && count === 1) throw new Error('synthetic_retry'); },
      translate: count => { if (stage === 'translation' && count === 1) throw new Error('synthetic_retry'); },
    });
    await run(client);
    assert.equal(observed.detects, stage === 'detector' ? 2 : 1);
    assert.equal(observed.fragments.length, stage === 'translation' ? 4 : 3);
    assert.equal(writes(client).length, 1);
    assert.equal(writes(client)[0].rows[0].status, 'translated');
    assert.equal(client._store.messages[0].language_detection_source, 'provider');
  });
}

for (const bound of [null, timestamp, later]) {
  for (const enabled of [false, true]) {
    test(`initial history bound ${bound} respects existing gate ${enabled}`, async () => {
      const client = database();
      client._store.feature_flags = [{ flag: 'telegraph_history_bound_enabled', enabled }];
      client._store.message_thread_members[0].visible_from_at = bound;
      const observed = provider();
      await run(client);
      const allowed = !enabled || bound !== later;
      assert.equal(observed.fragments.length, allowed ? 3 : 0);
      assert.equal(writes(client).length, allowed ? 1 : 0);
    });
  }
}

test('unchanged preference sweep refuses a current target mismatch without an invented grant', async () => {
  const client = database();
  client._store.messages[0].original_language = 'es';
  client._store.messages[0].language_detection_source = 'provider';
  client._store.message_translations = [{ message_id: messageId, recipient_id: recipientId, source_language: 'es', updated_at: timestamp }];
  const observed = provider();
  const { retranslateForUser } = await import('../services/messageTranslation.js');
  await retranslateForUser(client as unknown as SupabaseClient, recipientId, 'de');
  assert.equal(observed.detects, 0);
  assert.deepEqual(observed.fragments, []);
  assert.deepEqual(writes(client), []);
});

test('real schema column fixture accepts source checks and legacy confidence fallback', async () => {
  const tables = seed();
  const client = makeSchemaStrictClient(tables);
  const originalFrom = client.from.bind(client);
  const blocks = makeFailClosedClient({ rows: { blocks: [] } });
  client.from = table => table === 'blocks' ? blocks.from(table) : originalFrom(table);
  provider();
  await run(client as unknown as SupabaseClient);
  assert.equal(client.writes.filter(entry => entry.table === 'message_translations').length, 1);
  assert.ok(client.deadColumnErrors.every(error => error.table === 'message_translations' && ['confidence', 'provider_version'].includes(error.column)));
  assert.equal(tables.messages[0].body, body);
});

for (const changed of [false, true]) {
  test(`actual SDK dispatch ${changed ? 'refuses a changed revision' : 'uses encoded source predicates and real response shapes'}`, async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = seed();
    const requests: Array<{ method: string; url: URL; payload: Record<string, unknown> | null }> = [];
    const client = createClient('http://translation.fixture.invalid', 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, 'http://translation.fixture.invalid');
        const table = url.pathname.split('/').at(-1)!;
        assert.ok(table in tables, table);
        const method = init?.method ?? 'GET';
        const payload = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
        requests.push({ method, url, payload });
        let rows = tables[table].filter(row => [...url.searchParams].every(([column, filter]) => {
          if (['select', 'or'].includes(column)) return true;
          if (filter.startsWith('eq.')) return String(row[column]) === filter.slice(3);
          if (filter.startsWith('neq.')) return String(row[column]) !== filter.slice(4);
          if (filter === 'is.null') return row[column] === null;
          if (filter.startsWith('in.')) return filter.slice(3).replace(/[()]/g, '').split(',').includes(String(row[column]));
          return true;
        }));
        if (method === 'PATCH') rows.forEach(row => Object.assign(row, payload));
        if (method === 'POST') { assert.ok(payload); tables[table].push(payload); rows = [payload]; }
        const headers = new Headers(init?.headers);
        const single = headers.get('accept')?.includes('application/vnd.pgrst.object+json');
        return new Response(JSON.stringify(single ? rows[0] ?? null : rows), { status: 200, headers: { 'content-type': 'application/json' } });
      } },
    });
    const observed = provider({ detect: () => { if (changed) tables.messages[0].body = 'Replacement revision'; } });
    await run(client);
    assert.equal(observed.detects, 1);
    assert.equal(requests.filter(request => request.method === 'POST').length, changed ? 0 : 1);
    assert.equal(requests.filter(request => request.method === 'PATCH').length, changed ? 0 : 1);
    if (!changed) {
      const stamp = requests.find(request => request.method === 'PATCH')!;
      assert.equal(stamp.url.searchParams.get('body'), `eq.${body}`);
      assert.equal(stamp.url.searchParams.get('edited_at'), 'is.null');
      assert.deepEqual(Object.keys(stamp.payload!).sort(), ['language_detection_source', 'original_language']);
    }
  });
}
