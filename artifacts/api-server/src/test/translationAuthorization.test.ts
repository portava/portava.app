import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import router from '../routes/contentTranslation.js';
import { _setTestClient } from '../lib/http.js';
import { _setTestTranslationProvider } from '../lib/translation.js';
import { SelfHostedTranslationProvider } from '../lib/selfHostedTranslation.js';
import { retranslateForUser } from '../services/messageTranslation.js';
import { makeFailClosedClient } from './helpers/failClosedSupabase.js';

afterEach(() => { mock.restoreAll(); _setTestClient(null, false); _setTestTranslationProvider(null); });

async function routeFixture() {
  const viewer = randomUUID();
  const author = randomUUID();
  const post = randomUUID();
  const rows: Record<string, any[]> = {
    profiles: [{ id: viewer, preferred_language: 'en' }],
    posts: [{ id: post, author_id: author, content: 'Hola mundo.', status: 'active', post_status: 'published', visibility: 'public', original_language: 'es' }],
    blocks: [],
    content_translations: [{ entity_id: post, entity_type: 'post', target_language: 'en', status: 'translated', translated_fields: { content: 'STALE UNVERSIONED CACHE' } }],
  };
  let calls = 0;
  let during = () => {};
  let failedTable = '';
  const database = makeFailClosedClient({ rows, users: { viewer }, failOn: context => context.table === failedTable ? { code: '08006', message: 'unavailable' } : null });
  _setTestClient(database, true);
  mock.method(SelfHostedTranslationProvider.prototype, 'translateText', async (text: string) => {
    calls++; during();
    return { translatedText: text.replace('Hola', 'Hello'), provider: 'self-hosted', providerVersion: 'fixture-1' };
  });
  const app = express();
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/content/post/${post}/translation?lang=en`;
  return {
    rows, viewer, author, calls: () => calls,
    during: (callback: () => void) => { during = callback; },
    fail: (table: string) => { failedTable = table; },
    get: (authenticated = true) => fetch(url, { headers: authenticated ? { Authorization: 'Bearer viewer' } : {} }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('actual content HTTP route uses viewer/source cache, preserves original and ignores unversioned legacy cache', async () => {
  const fixture = await routeFixture();
  try {
    const first = await fixture.get();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await first.json() as any).translatedFields, { content: 'Hello mundo.' });
    assert.equal(fixture.rows.posts[0].content, 'Hola mundo.');
    await fixture.get();
    assert.equal(fixture.calls(), 1);
    fixture.rows.posts[0].content = 'Hola otro mundo.';
    assert.deepEqual((await (await fixture.get()).json() as any).translatedFields, { content: 'Hello otro mundo.' });
    assert.equal(fixture.calls(), 2);
  } finally { await fixture.close(); }
});

for (const denial of ['unauthenticated', 'followers_only', 'unknown_visibility', 'deleted', 'blocked', 'preferences_unreadable', 'no_preference']) {
  test(`content HTTP ${denial} does not invoke provider or reveal cached fields`, async () => {
    const fixture = await routeFixture();
    try {
      if (denial === 'followers_only' || denial === 'unknown_visibility') fixture.rows.posts[0].visibility = denial;
      if (denial === 'deleted') fixture.rows.posts[0].status = 'deleted';
      if (denial === 'blocked') fixture.rows.blocks.push({ blocker_id: fixture.author, blocked_id: fixture.viewer });
      if (denial === 'preferences_unreadable') fixture.fail('profiles');
      if (denial === 'no_preference') fixture.rows.profiles[0].preferred_language = null;
      const response = await fixture.get(denial !== 'unauthenticated');
      const body = await response.json() as any;
      assert.equal(fixture.calls(), 0);
      assert.ok(!body.translatedFields || !Object.keys(body.translatedFields).length);
      if (denial === 'no_preference') assert.equal(body.status, 'skipped');
      else if (denial === 'preferences_unreadable') assert.equal(response.status, 503);
      else assert.ok([401, 404].includes(response.status));
    } finally { await fixture.close(); }
  });
}

for (const denial of ['block', 'delete', 'edit', 'preferences']) {
  test(`content HTTP late ${denial} discards provider output`, async () => {
    const fixture = await routeFixture();
    try {
      fixture.during(() => {
        if (denial === 'block') fixture.rows.blocks.push({ blocker_id: fixture.author, blocked_id: fixture.viewer });
        if (denial === 'delete') fixture.rows.posts[0].status = 'deleted';
        if (denial === 'edit') fixture.rows.posts[0].content = 'Changed original.';
        if (denial === 'preferences') fixture.rows.profiles[0].preferred_language = 'fr';
      });
      const response = await fixture.get();
      assert.equal(response.status, 404);
      assert.equal((await response.json() as any).translatedFields, undefined);
      assert.equal(fixture.calls(), 1);
    } finally { await fixture.close(); }
  });
}

for (const denial of ['none', 'e2ee', 'missing_thread', 'ciphertext', 'deleted', 'left', 'block', 'preferences', 'read_error', 'late_e2ee', 'late_delete']) {
  test(`Telegraph preference sweep ${denial} respects current authorization before processing/persisting`, async () => {
    const viewer = randomUUID();
    const sender = randomUUID();
    const thread = randomUUID();
    const message = randomUUID();
    const rows: Record<string, any[]> = {
      messages: [{ id: message, body: 'Hola mundo.', original_language: 'es', language_detection_source: 'provider', thread_id: thread, sender_id: sender, ciphertext: null, deleted_at: null }],
      message_threads: [{ id: thread, is_e2ee: false }],
      message_thread_members: [{ thread_id: thread, user_id: viewer, left_at: null }],
      profiles: [{ id: viewer, preferred_language: 'en', auto_translate_messages: true }],
      message_translations: [{ message_id: message, recipient_id: viewer, source_language: 'es' }], blocks: [],
    };
    if (denial === 'e2ee') rows.message_threads[0].is_e2ee = true;
    if (denial === 'missing_thread') rows.message_threads = [];
    if (denial === 'ciphertext') rows.messages[0].ciphertext = 'opaque';
    if (denial === 'deleted') rows.messages[0].deleted_at = '2026-10-15';
    if (denial === 'left') rows.message_thread_members[0].left_at = '2026-10-15';
    if (denial === 'block') rows.blocks.push({ blocker_id: sender, blocked_id: viewer });
    if (denial === 'preferences') rows.profiles[0].auto_translate_messages = false;
    const inserted: Record<string, any[]> = {};
    const database = makeFailClosedClient({ rows, inserted, failOn: context => denial === 'read_error' && context.table === 'message_threads' ? { code: '08006', message: 'unavailable' } : null });
    const writes: any[] = [];
    const from = database.from.bind(database);
    database.from = (table: string) => {
      const chain = from(table);
      if (table === 'message_translations') {
        const upsert = chain.upsert.bind(chain);
        chain.upsert = (value: any, options: any) => { writes.push(value); return upsert(value, options); };
      }
      return chain;
    };
    let calls = 0;
    _setTestTranslationProvider({
      async detectLanguage() { throw new Error('unexpected detection'); },
      async translateText() {
        calls++;
        if (denial === 'late_e2ee') rows.message_threads[0].is_e2ee = true;
        if (denial === 'late_delete') rows.messages[0].deleted_at = '2026-10-15';
        return { translatedText: 'Hello world.', provider: 'fixture', providerVersion: 'fixture-1' };
      },
    });
    await retranslateForUser(database, viewer, 'en');
    assert.equal(calls, denial === 'none' || denial.startsWith('late_') ? 1 : 0);
    assert.equal(writes.length, denial === 'none' ? 1 : 0);
    if (denial === 'none') assert.equal(inserted.message_translations[0].translated_body, 'Hello world.');
    else assert.equal(inserted.message_translations, undefined);
    assert.equal(rows.messages[0].body, 'Hola mundo.');
  });
}
