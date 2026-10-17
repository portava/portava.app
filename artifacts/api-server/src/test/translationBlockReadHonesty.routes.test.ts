import assert from 'node:assert/strict';
import { before, after, afterEach, test } from 'node:test';
import contentRouter from '../routes/contentTranslation.js';
import ogRouter from '../routes/og.js';
import { makeFakeClient, startRouter, type RouterHarness } from './telegraphCertificationHarness.js';
import { _setTestClient } from '../lib/http.js';

const viewerId = '22222222-2222-4222-8222-222222222222';
const ownerId = '11111111-1111-4111-8111-111111111111';
const entityId = '44444444-4444-4444-8444-444444444444';
const originalFetch = globalThis.fetch;
const originalProviderUrl = process.env.TRANSLATION_SELF_HOSTED_URL;
const originalProviderToken = process.env.TRANSLATION_SELF_HOSTED_TOKEN;
let content: RouterHarness;
let og: RouterHarness;

before(async () => { content = await startRouter(contentRouter); og = await startRouter(ogRouter); });
after(async () => { await content.close(); await og.close(); });
afterEach(() => {
  _setTestClient(null, false);
  globalThis.fetch = originalFetch;
  if (originalProviderUrl === undefined) delete process.env.TRANSLATION_SELF_HOSTED_URL;
  else process.env.TRANSLATION_SELF_HOSTED_URL = originalProviderUrl;
  if (originalProviderToken === undefined) delete process.env.TRANSLATION_SELF_HOSTED_TOKEN;
  else process.env.TRANSLATION_SELF_HOSTED_TOKEN = originalProviderToken;
});

function database(value: unknown, visibility = 'public') {
  const client = makeFakeClient({
    profiles: [{ id: viewerId, account_status: 'active', preferred_language: 'fr' },
      { id: ownerId, account_status: 'active', is_private: false, bio: 'Nos vemos en el muelle.', bio_original_language: 'es' }],
    user_account_states: [], trust_restrictions: [], feature_flags: [], blocks: [],
    events: [{ id: entityId, host_id: ownerId, title: 'Public review event', description: 'Synthetic public description',
      visibility, state: 'published', city: 'Paris', country: 'France', cover_url: null }],
    trips: [{ id: entityId, owner_id: ownerId, title: 'Public review trip', visibility,
      destination_city: 'Paris', destination_country: 'France', show_destination_city: true, cover_url: null }],
  });
  const from = client.from.bind(client);
  let blockReads = 0;
  client.from = table => {
    const query = from(table);
    if (table === 'blocks') query.then = (resolve: (result: { data: unknown; error: null }) => unknown, reject: (error: unknown) => unknown) => {
      blockReads += 1;
      return Promise.resolve({ data: value, error: null }).then(resolve, reject);
    };
    return query;
  };
  return { client, count: () => blockReads };
}

const contentCases: Array<[string, unknown]> = [['empty', []], ['null', null], ['object', { blocker_id: ownerId }]];
for (const [label, value] of contentCases) {
  test(`mounted content bio translation ${label} block response`, async () => {
    const databaseState = database(value);
    databaseState.client._store.profiles[1].bio += ` ${label}`;
    _setTestClient(databaseState.client, true);
    process.env.TRANSLATION_SELF_HOSTED_URL = 'http://127.0.0.1:9/';
    process.env.TRANSLATION_SELF_HOSTED_TOKEN = 'dummy-fixture-token-not-a-secret-000000';
    let providerCalls = 0;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:9/v1/translate');
      providerCalls += 1;
      const payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ translatedText: `Traduction ${payload.text}`, source: payload.source,
        target: payload.target, providerVersion: 'fixture-one' }), { headers: { 'content-type': 'application/json' } });
    };
    const response = await originalFetch(`${content.base}/content/bio/${ownerId}/translation?lang=fr`, {
      headers: { authorization: `Bearer ${viewerId}` },
    });
    const result = await response.json();
    assert.ok(databaseState.count() > 0);
    assert.equal(response.status, label === 'empty' ? 200 : 404);
    assert.equal(providerCalls, label === 'empty' ? 1 : 0);
    assert.ok(result && typeof result === 'object');
    if (label === 'empty') {
      assert.ok('status' in result && 'translatedFields' in result);
      assert.equal(result.status, 'translated');
      assert.deepEqual(result.translatedFields, { bio: 'Traduction Nos vemos en el muelle. empty' });
    } else {
      assert.ok('error' in result);
      assert.equal(result.error, 'not_found');
    }
  });
}

const cardCases: Array<[string, unknown, boolean, string, boolean]> = [
  ['anonymous-public', null, false, 'public', true],
  ['anonymous-private', null, false, 'private', false],
  ['authenticated-null', null, true, 'public', false],
  ['authenticated-object', { blocker_id: ownerId }, true, 'public', false],
  ['authenticated-empty', [], true, 'public', true],
  ['authenticated-block', [{ blocker_id: ownerId }], true, 'public', false],
];
for (const type of ['event', 'trip']) {
  for (const [label, value, authenticated, visibility, publicCard] of cardCases) {
    test(`mounted ${type} OG ${label} preserves public/known-empty/refusal boundary`, async () => {
      const databaseState = database(value, visibility);
      _setTestClient(databaseState.client, true);
      const response = await originalFetch(`${og.base}/og/${type}/${entityId}`, {
        headers: authenticated ? { authorization: `Bearer ${viewerId}` } : {},
      });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.equal(html.includes(`Public review ${type}`), publicCard);
      assert.equal(databaseState.count() > 0, authenticated);
    });
  }
}
