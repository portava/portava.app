/**
 * Post saves and collections.
 *
 * saveItem('post', id, collectionId) wrote post_saves and dropped the
 * collectionId, so "Save to collection" on a post put nothing in the
 * collection. It now also files the post in the chosen collection, and an
 * unsave clears those collection rows before the post_saves row. The Saved
 * screen's list of saved posts (getMySavedPostIds) reports a failed read
 * instead of an empty list.
 *
 * Run with: pnpm test:component (jest: the module chain reaches react-native)
 */
// NOTE: intentionally exhaustive — the real Supabase client pulls react-native
// native internals that crash under jest-expo. apiToken's session reads go through
// its own `_setTestSupabase` seam, so the token chain below is the production one.
jest.mock('../../lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: true }));

import assert from 'node:assert/strict';
import { _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';
import { saveItem, unsaveItem, getMySavedPostIds } from '../collections.ts';

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const session = {
  auth: {
    getSession: () => Promise.resolve({ data: { session: { access_token: 'tok', expires_at: FAR_FUTURE } } }),
    refreshSession: () => Promise.resolve({ data: { session: { access_token: 'tok' } } }),
  },
};

type Call = { method: string; path: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
/** Status per "METHOD path"; anything unlisted answers 200. */
let statusFor: Record<string, number> = {};
let bodyFor: Record<string, unknown> = {};
const realFetch = globalThis.fetch;
const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;

const POST = '11111111-1111-4111-8111-111111111111';
const COL = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  calls = []; statusFor = {}; bodyFor = {};
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  _setTestSupabase(session as any);
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const path = String(url).replace('http://api.test', '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : null });
    const key = `${method} ${path}`;
    const status = statusFor[key] ?? 200;
    return { ok: status < 300, status, json: async () => bodyFor[key] ?? {} } as unknown as Response;
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
  _resetTestSupabase();
});

const sent = () => calls.map((c) => `${c.method} ${c.path}`);

describe('post saves reach the chosen collection', () => {
  it('a plain bookmark writes post_saves only', async () => {
    assert.equal(await saveItem('post', POST), true);
    assert.deepEqual(sent(), [`POST /api/posts/${POST}/save`]);
  });

  it('saving into a collection also files the post in THAT collection', async () => {
    assert.equal(await saveItem('post', POST, COL), true);
    assert.deepEqual(sent(), [`POST /api/posts/${POST}/save`, 'POST /api/saves']);
    assert.deepEqual(calls[1]!.body, { entity_type: 'post', entity_id: POST, collection_id: COL });
  });

  it('a refused post save writes nothing to the collection and reports failure', async () => {
    statusFor[`POST /api/posts/${POST}/save`] = 403;
    assert.equal(await saveItem('post', POST, COL), false);
    assert.equal(calls.length, 1);
  });

  it('a refused collection write reports failure', async () => {
    statusFor['POST /api/saves'] = 500;
    assert.equal(await saveItem('post', POST, COL), false);
  });
});

describe('unsaving a post', () => {
  it('clears the collection rows, then post_saves', async () => {
    assert.equal(await unsaveItem('post', POST), true);
    assert.deepEqual(sent(), ['DELETE /api/saves', `DELETE /api/posts/${POST}/save`]);
    assert.deepEqual(calls[0]!.body, { entity_type: 'post', entity_id: POST });
  });

  it('when the collection rows cannot be cleared, the post stays saved', async () => {
    statusFor['DELETE /api/saves'] = 500;
    assert.equal(await unsaveItem('post', POST), false);
    assert.equal(calls.length, 1, 'post_saves must not be touched');
  });
});

describe('getMySavedPostIds', () => {
  it('returns the ids, and a failed read is not an empty list', async () => {
    bodyFor['GET /api/posts/saved-by-me'] = { postIds: [POST] };
    assert.deepEqual(await getMySavedPostIds(), { ok: true, postIds: [POST] });
    statusFor['GET /api/posts/saved-by-me'] = 503;
    assert.deepEqual(await getMySavedPostIds(), { ok: false });
  });
});
