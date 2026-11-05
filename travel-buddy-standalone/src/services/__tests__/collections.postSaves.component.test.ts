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
jest.mock('../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => {
    listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
  } } } };
});

import assert from 'node:assert/strict';
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken, emitObservedAuthEvent, observedOwnerSession } from './observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../discoveryViewerScope.ts';
const TOKEN = observedOwnerAccessToken('owner-a', 'session-a');
import { _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';
import { saveItem, unsaveItem, getMySavedPostIds, getCollectionItems, readCollections, checkSaved, createCollection, updateCollection, deleteCollection, getMySavedGems } from '../collections.ts';

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const session = {
  auth: {
    getSession: () => Promise.resolve({ data: { session: { access_token: TOKEN, expires_at: FAR_FUTURE } } }),
    refreshSession: () => Promise.resolve({ data: { session: { access_token: TOKEN } } }),
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
  setDiscoveryViewerFromSession('owner-a'); seedObservedOwnerSession('owner-a', 'session-a');
  calls = []; statusFor = {}; bodyFor = {};
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  _setTestSupabase(session as any);
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const path = String(url).replace('https://api.test', '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : null });
    const key = `${method} ${path}`;
    const status = statusFor[key] ?? 200;
    return { ok: status < 300, status, json: async () => bodyFor[key] ?? {} } as unknown as Response;
  }) as typeof fetch;
});
afterEach(() => {
  jest.restoreAllMocks(); jest.useRealTimers();
  disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null);
  globalThis.fetch = realFetch;
  if (realBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
  _resetTestSupabase();
});

describe('Saved request ownership and deadlines', () => {
  for (const replacement of ['different account', 'same account new session', 'logout and login']) {
    it(`does not dispatch work after refresh crosses ${replacement}`, async () => {
      let finish!: (value: Awaited<ReturnType<typeof session.auth.getSession>>) => void;
      jest.spyOn(session.auth, 'getSession').mockReturnValue(new Promise(resolve => { finish = resolve; }));
      const pending = [readCollections(), createCollection('Food'), updateCollection(COL, { name: 'Food' }), deleteCollection(COL),
        saveItem('post', POST, COL), unsaveItem('post', POST), checkSaved('post', POST), getCollectionItems(COL), getMySavedPostIds(), getMySavedGems(), saveItem('gem', POST, COL), unsaveItem('gem', POST)];
      const owner = replacement === 'different account' ? 'owner-b' : 'owner-a';
      if (replacement === 'logout and login') emitObservedAuthEvent('SIGNED_OUT', null);
      const sessionId = replacement === 'logout and login' ? 'session-a' : 'session-b';
      setDiscoveryViewerFromSession(owner); emitObservedAuthEvent('SIGNED_IN', observedOwnerSession(owner, sessionId));
      finish({ data: { session: { access_token: observedOwnerAccessToken(owner, sessionId), expires_at: FAR_FUTURE } } });
      await Promise.all(pending);
      expect(calls).toHaveLength(0);
    });
  }
  it('does not execute the second post-save step after logout, even with the original session restored', async () => {
    const original = global.fetch;
    global.fetch = (async (...args: Parameters<typeof fetch>) => {
      const result = await original(...args);
      emitObservedAuthEvent('SIGNED_OUT', null);
      emitObservedAuthEvent('SIGNED_IN', observedOwnerSession('owner-a', 'session-a'));
      return result;
    }) as typeof fetch;
    expect(await saveItem('post', POST, COL)).toBe(false);
    expect(sent()).toEqual([`POST /api/posts/${POST}/save`]);
  });
  it('rejects a collection list decoded after the account changed', async () => {
    const response = new Response('{}');
    jest.spyOn(response, 'json').mockImplementation(async () => {
      emitObservedAuthEvent('SIGNED_OUT', null); return { collections: [{ id: COL, name: 'Private' }] };
    });
    global.fetch = async () => response;
    expect(await readCollections()).toEqual({ ok: false, data: [] });
  });
  for (const stage of ['token', 'headers', 'body']) {
    it(`bounds an unresponsive ${stage}`, async () => {
      jest.useFakeTimers();
      if (stage === 'token') jest.spyOn(session.auth, 'getSession').mockReturnValue(new Promise(() => {}));
      else if (stage === 'headers') global.fetch = (() => new Promise(() => {})) as typeof fetch;
      else {
        const response = new Response('{}');
        jest.spyOn(response, 'json').mockImplementation(() => new Promise<unknown>(() => {}));
        global.fetch = async () => response;
      }
      const pending = readCollections();
      await jest.advanceTimersByTimeAsync(10_001);
      expect(await pending).toEqual({ ok: false, data: [] });
    });
  }
  it('reports unknown save status on failed or malformed reads', async () => {
    const path = `GET /api/users/me/saves?entity_type=post&entity_id=${POST}`;
    statusFor[path] = 503;
    expect(await checkSaved('post', POST)).toMatchObject({ ok: false });
    statusFor[path] = 200; bodyFor[path] = { saved: 'yes', collectionIds: [] };
    expect(await checkSaved('post', POST)).toMatchObject({ ok: false });
    bodyFor[path] = { saved: true, collectionIds: [] };
    expect(await checkSaved('post', POST)).toEqual({ ok: true, saved: true, collectionIds: [] });
  });
  it('refuses redirected requests carrying private collection credentials', async () => {
    const response = new Response(JSON.stringify({ collections: [] }));
    Object.defineProperties(response, { redirected: { value: true }, url: { value: 'https://foreign.test' } });
    global.fetch = async () => response;
    expect(await readCollections()).toEqual({ ok: false, data: [] });
  });
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

  it.each([400, 404])('never substitutes the default collection after a %i', async (status) => {
    statusFor['POST /api/saves'] = status;
    assert.equal(await saveItem('post', POST, COL), false);
    assert.deepEqual(sent(), [`POST /api/posts/${POST}/save`, 'POST /api/saves']);
    assert.equal(calls[1]!.body!.collection_id, COL);
  });

  it('files other item types in the selected collection directly', async () => {
    assert.equal(await saveItem('place', POST, COL), true);
    assert.deepEqual(sent(), ['POST /api/saves']);
    assert.deepEqual(calls[0]!.body, { entity_type: 'place', entity_id: POST, collection_id: COL });
  });
});

describe('collection contents', () => {
  it('refuses malformed pages instead of inventing an empty collection or looping a cursor', async () => {
    const path = `GET /api/users/me/collections/${COL}/items?limit=40`;
    for (const body of [{}, { items: {}, hasMore: false, nextCursor: null }, { items: [], hasMore: true, nextCursor: null }]) {
      bodyFor[path] = body;
      expect(await getCollectionItems(COL)).toEqual({ ok: false });
    }
  });
  it('distinguishes a failed read from a genuinely empty collection', async () => {
    const path = `GET /api/users/me/collections/${COL}/items?limit=40`;
    statusFor[path] = 503;
    assert.deepEqual(await getCollectionItems(COL), { ok: false });
    statusFor[path] = 200;
    bodyFor[path] = { items: [], hasMore: false, nextCursor: null };
    assert.deepEqual(await getCollectionItems(COL), { ok: true, items: [], hasMore: false, nextCursor: null });
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


describe('gem collection transport', () => {
  it('saves directly into the chosen private collection and unsaves through the atomic bridge', async () => {
    expect(await saveItem('gem', POST, COL)).toBe(true);
    expect(calls[0]!.body).toEqual({ entity_type: 'gem', entity_id: POST, collection_id: COL });
    expect(await unsaveItem('gem', POST)).toBe(true);
    expect(sent()).toEqual(['POST /api/saves', 'DELETE /api/saves']);
  });
  it('retains unavailable saved references and rejects malformed or late responses', async () => {
    const path = 'GET /api/users/me/saved-gems';
    bodyFor[path] = { gems: [{ id: POST, title: null, savedAt: '2026-11-05' }], nextCursor: null };
    expect(await getMySavedGems()).toMatchObject({ ok: true, gems: [{ id: POST, title: null }] });
    bodyFor[path] = { gems: [{ id: POST }], nextCursor: null };
    expect((await getMySavedGems()).ok).toBe(false);
    const response = new Response('{}');
    jest.spyOn(response, 'json').mockImplementation(async () => {
      emitObservedAuthEvent('SIGNED_OUT', null);
      return { gems: [{ id: POST, title: 'Private', savedAt: '2026-11-05' }], nextCursor: null };
    });
    global.fetch = async () => response;
    expect(await getMySavedGems()).toEqual({ ok: false, gems: [], nextCursor: null });
  });
});
