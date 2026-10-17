import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { _setTestClient } from '../lib/http.js';
import { _setTestTranslationProvider } from '../lib/translation.js';
import { subscribe, type TelegraphEvent } from '../lib/telegraphEvents.js';
import { _resetRateLimit } from '../lib/rateLimit.js';
import { _clearSendTierCache } from '../domain/telegraph/policies/sendRateLimit.js';
import { __resetConfidenceColumnProbe } from '../services/messageTranslation.js';
import messagingRouter from '../routes/messaging.js';
import groupChatRouter from '../routes/groupChat.js';
import { call, makeFakeClient, resetFakeIds, startRouter, type RouterHarness } from './telegraphCertificationHarness.js';

const senderId = '11111111-1111-4111-8111-111111111111';
const recipientId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';
const messageId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const timestamp = '2026-10-01T00:00:00.000Z';
const body = 'Primera frase https://example.invalid/keep Segunda frase @alice Tercera frase';
const messageDefaults = { deleted_at: null, edited_at: null, ciphertext: null, unsent_at: null,
  original_language: null, language_detection_source: null, msg_type: 'text' };

function database() {
  return makeFakeClient({
    feature_flags: [], blocks: [],
    profiles: [senderId, recipientId].map(id => ({ id, handle: id, name: id, account_status: null,
      preferred_language: id === senderId ? 'es' : 'fr', preferred_message_language: 'en', auto_translate_messages: true })),
    user_message_settings: [], user_friendships: [], user_follows: [], circle_memberships: [],
    trust_profiles: [], trust_restrictions: [], trips: [], trip_members: [],
    message_requests: [{ id: requestId, sender_id: senderId, recipient_id: recipientId, status: 'pending', preview_text: body }],
    message_threads: [{ id: threadId, thread_type: 'direct', status: 'active', is_e2ee: false,
      created_at: timestamp, updated_at: timestamp, last_message_at: null }],
    message_thread_members: [senderId, recipientId].map(user_id => ({ thread_id: threadId, user_id, role: 'member',
      joined_at: timestamp, left_at: null, visible_from_at: null, last_read_at: null, muted_at: null, archived_at: null })),
    messages: [{ ...messageDefaults, id: messageId, thread_id: threadId, sender_id: senderId, body, created_at: timestamp }],
    message_translations: [{ id: requestId, message_id: messageId, recipient_id: recipientId, source_language: 'es',
      target_language: 'fr', translated_body: null, provider: null, status: 'failed', error_message: 'synthetic_failure' }],
  }, { columnDefaults: { messages: messageDefaults } });
}

let messaging: RouterHarness;
let groups: RouterHarness;
before(async () => { messaging = await startRouter(messagingRouter); groups = await startRouter(groupChatRouter); });
after(async () => { await messaging.close(); await groups.close(); });
beforeEach(() => { resetFakeIds(); _resetRateLimit(); _clearSendTierCache(); __resetConfidenceColumnProbe(); });
afterEach(() => { _setTestClient(null, false); _setTestTranslationProvider(null); });

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'background pipeline did not reach the observed boundary');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const route of ['send', 'edit', 'retry', 'preview', 'group-edit'] as const) {
  for (const revoked of [false, true]) {
    test(`mounted ${route} ${revoked ? 'stops after first-fragment revocation' : 'retains healthy background translation'}`, async () => {
      const client = database();
      if (route === 'send' || route === 'preview') client._store.messages = [];
      _setTestClient(client, true);
      const fragments: string[] = [];
      let release!: () => void;
      let entered = false;
      let afterReleaseRead = false;
      let released = false;
      const paused = new Promise<void>(resolve => { release = resolve; });
      const originalFrom = client.from.bind(client);
      client.from = table => {
        if (released && ['messages', 'message_thread_members', 'profiles'].includes(table)) afterReleaseRead = true;
        return originalFrom(table);
      };
      _setTestTranslationProvider({
        async detectLanguage() { return { language: 'es', confidence: 'high' }; },
        async translateText(fragment) {
          fragments.push(fragment);
          if (fragments.length === 1) { entered = true; await paused; }
          return { translatedText: `Traduction ${fragment}`, provider: 'synthetic-only', providerVersion: 'one' };
        },
      });
      const events: TelegraphEvent[] = [];
      const unsubscribe = subscribe(recipientId, event => { if (event.type === 'message.translated') events.push(event); });
      try {
        const response = route === 'send' ? await call(messaging.base, 'POST', `/threads/${threadId}/messages`, senderId, { body })
          : route === 'edit' ? await call(messaging.base, 'PATCH', `/threads/${threadId}/messages/${messageId}`, senderId, { body })
          : route === 'retry' ? await call(messaging.base, 'POST', `/messages/${messageId}/translate/retry`, recipientId)
          : route === 'preview' ? await call(messaging.base, 'POST', `/message-requests/${requestId}/accept`, recipientId)
          : await call(groups.base, 'PATCH', `/messages/${messageId}`, senderId, { body });
        assert.equal(response.status, route === 'send' ? 201 : route === 'retry' ? 202 : 200, JSON.stringify(response.body));
        await until(() => entered);
        assert.equal(fragments.length, 1);
        if (revoked) client._store.blocks.push({ blocker_id: recipientId, blocked_id: senderId });
        released = true;
        release();
        await until(() => revoked ? afterReleaseRead || events.length > 0 : events.length > 0);
        await new Promise(resolve => setTimeout(resolve, 20));
        const writes = client._observed.upserts.filter(entry => entry.table === 'message_translations');
        assert.equal(fragments.length, revoked ? 1 : 3);
        assert.equal(writes.length, revoked ? 0 : 1);
        assert.equal(events.length, revoked ? 0 : 1);
        assert.ok(client._store.messages.every(message => message.body === body));
        if (!revoked) {
          assert.equal(writes[0].rows[0].recipient_id, recipientId);
          assert.equal(writes[0].rows[0].provider_version, 'one');
          assert.match(writes[0].rows[0].translated_body, /@alice/);
          assert.match(writes[0].rows[0].translated_body, /https:\/\/example\.invalid\/keep/);
        }
      } finally { release(); unsubscribe(); }
    });
  }
}
