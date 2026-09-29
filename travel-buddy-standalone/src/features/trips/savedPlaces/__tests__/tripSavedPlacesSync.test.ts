/**
 * TRIP-F25 — trip saved places synced to /api/trips/:id/saved-places, and the
 * WP10-D1 merge rule for saves that exist only on this device.
 * Run: node --import tsx/esm --test src/features/trips/savedPlaces/__tests__/tripSavedPlacesSync.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

type Mod = typeof import('../tripSavedPlacesSync.ts');
let mod: Mod;
let calls: { url: string; method: string; body: any }[] = [];
let server: any[] = [];
let failPostFor = new Set<string>();
let failGet = false;
let failDelete = false;
/** When set, GET answers this list instead of `server` (a read that lags a write). */
let getOverride: any[] | null = null;
const realFetch = globalThis.fetch;
let nextId = 100;

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url: String(url), method, body });
  const path = String(url).replace('http://api.test', '');
  if (method === 'GET') {
    if (failGet) return new Response(JSON.stringify({ error: 'db_error', message: 'down' }), { status: 500 });
    return new Response(JSON.stringify({ savedPlaces: getOverride ?? server }), { status: 200 });
  }
  if (method === 'POST') {
    if (failPostFor.has(body.placeId)) throw new Error('offline');
    if (server.some((r) => r.user_id === 'me' && r.place_id === body.placeId)) {
      return new Response(JSON.stringify({ error: 'duplicate', message: 'This place is already saved to the trip' }), { status: 409 });
    }
    const row = { id: `e${nextId++}`, place_id: body.placeId, place_name: body.placeName, place_type: body.placeType ?? null, lat: body.lat ?? null, lng: body.lng ?? null, notes: null, user_id: 'me', saved_at: '2026-09-29T00:00:00Z' };
    server.push(row);
    return new Response(JSON.stringify(row), { status: 201 });
  }
  if (method === 'DELETE') {
    if (failDelete) return new Response(JSON.stringify({ error: 'db_error', message: 'nope' }), { status: 500 });
    const id = path.split('/').pop();
    server = server.filter((r) => r.id !== id);
    return new Response(null, { status: 204 });
  }
  return new Response('{}', { status: 500 });
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const store = new Map<string, string>();
let removedLocal: string[] = [];
let readdedLocal: string[] = [];
const local = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Place ${id}`, category: 'food', type: null, address: null, savedAt: 1000, listId: 't1', ...extra });
const row = (id: string, placeId: string, user: string) => ({ id, place_id: placeId, place_name: `Place ${placeId}`, place_type: 'food', lat: null, lng: null, notes: null, user_id: user, saved_at: '2026-09-20T00:00:00Z' });

describe('trip saved places sync', () => {
  before(async () => {
    mod = await import('../tripSavedPlacesSync.ts');
    const { _setTestToken } = await import('../../shared/auth.ts');
    _setTestToken(async () => 'tok');
    mod._setTestDeps({
      accountId: async () => 'me',
      getItem: async (k) => store.get(k) ?? null,
      setItem: async (k, v) => { store.set(k, v); },
      removeLocal: async (id) => { removedLocal.push(id); },
      ensureLocal: async (p) => { readdedLocal.push(p.id); },
    });
  });
  beforeEach(() => { calls = []; server = []; store.clear(); failPostFor = new Set(); failGet = false; failDelete = false; getOverride = null; removedLocal = []; readdedLocal = []; });

  it('FIRST SYNC: every device-only save is pushed to the trip (union) and none is lost', async () => {
    server = [row('e1', 'b', 'me'), row('e2', 'x', 'crew')];
    const r = await mod.syncTripSavedPlaces('t1', [local('a'), local('b')]);
    assert.equal(r.state, 'ok');
    if (r.state !== 'ok') return;
    // 'a' was pushed; 'b' was already the member's, so it is acknowledged without a second row.
    assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body.placeId), ['a']);
    assert.deepEqual(r.places.map((p) => p.id).sort(), ['a', 'b', 'x']);
    assert.equal(r.pending, 0);
    // The crewmate's save is visible and marked as theirs.
    const x = r.places.find((p) => p.id === 'x')!;
    assert.equal(x.mine, false);
    assert.equal(removedLocal.length, 0, 'the first sync deletes nothing');
  });

  it('a push that fails keeps the save as PENDING — shown, counted, and pushed again next time', async () => {
    failPostFor = new Set(['a']);
    const first = await mod.syncTripSavedPlaces('t1', [local('a')]);
    assert.equal(first.state, 'ok');
    if (first.state === 'ok') {
      assert.equal(first.pending, 1);
      assert.equal(first.places[0]!.pending, true);
    }
    // Re-persisted on the device, so a later rewrite of the device list cannot drop it before it syncs.
    assert.deepEqual(readdedLocal, ['a']);
    failPostFor = new Set();
    calls = [];
    const second = await mod.syncTripSavedPlaces('t1', [local('a')]);
    assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body.placeId), ['a']);
    if (second.state === 'ok') assert.equal(second.pending, 0);
  });

  it('a 409 "already saved" is an acknowledgement, not a failure', async () => {
    // The list read does not show the member's row yet, but the server already has it: POST answers 409.
    server = [row('e5', 'a', 'me')];
    getOverride = [];
    const r = await mod.syncTripSavedPlaces('t1', [local('a')]);
    assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body.placeId), ['a']);
    assert.equal(r.state, 'ok');
    if (r.state === 'ok') assert.equal(r.pending, 0, '409 is not left pending');
    // And being acknowledged, it is not pushed again once the read catches up and then loses it.
    getOverride = null; server = []; calls = [];
    await mod.syncTripSavedPlaces('t1', [local('a')]);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });

  it('ONCE ACKNOWLEDGED the server is authoritative: a save removed elsewhere is dropped here, not resurrected', async () => {
    await mod.syncTripSavedPlaces('t1', [local('a')]);
    server = []; // removed on another device, or by the owner
    calls = [];
    const r = await mod.syncTripSavedPlaces('t1', [local('a')]);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'not pushed back');
    assert.deepEqual(removedLocal, ['a']);
    if (r.state === 'ok') assert.deepEqual(r.places, []);
  });

  it('a crewmate saving the same place does not acknowledge MY save — mine is still pushed, so their removal cannot take mine with it', async () => {
    server = [row('e9', 'a', 'crew')];
    await mod.syncTripSavedPlaces('t1', [local('a')]);
    assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body.placeId), ['a']);
  });

  it('an unreadable server list is unavailable — nothing is pushed or dropped on a guess', async () => {
    failGet = true;
    const r = await mod.syncTripSavedPlaces('t1', [local('a')]);
    assert.equal(r.state, 'unavailable');
    assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
    assert.equal(removedLocal.length, 0);
  });

  it('removing: my server entry is DELETEd and the acknowledgement forgotten; a pending one is local only', async () => {
    const s = await mod.syncTripSavedPlaces('t1', [local('a'), local('p')]);
    assert.equal(s.state, 'ok');
    if (s.state !== 'ok') return;
    const a = s.places.find((p) => p.id === 'a')!;
    const rem = await mod.removeTripSavedPlace('t1', a);
    assert.equal(rem.state, 'done');
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/saved-places/${a.entryId}`)));
    const pending = { ...local('q'), entryId: null, pending: true, mine: true, savedBy: 'me' };
    calls = [];
    const r2 = await mod.removeTripSavedPlace('t1', pending as any);
    assert.equal(r2.state, 'done');
    assert.equal(calls.length, 0);
  });

  it('the picker toggle: a save reaches the trip list; an unsave that the server refuses is rolled back locally', async () => {
    const saved = await mod.applyTripSaveToggle('t1', local('z') as any, true);
    assert.equal(saved.state, 'synced');
    assert.ok(server.some((r) => r.place_id === 'z' && r.user_id === 'me'));
    failDelete = true;
    const un = await mod.applyTripSaveToggle('t1', local('z') as any, false);
    assert.equal(un.state, 'failed');
    assert.deepEqual(readdedLocal, ['z']);
    failDelete = false;
    const un2 = await mod.applyTripSaveToggle('t1', local('z') as any, false);
    assert.equal(un2.state, 'synced');
    assert.equal(server.some((r) => r.place_id === 'z'), false);
  });

  it('off when not configured / signed out: the device list is used as before', async () => {
    mod._setTestDeps({ accountId: async () => null, getItem: async () => null, setItem: async () => {}, removeLocal: async () => {}, ensureLocal: async () => {} });
    assert.equal((await mod.syncTripSavedPlaces('t1', [local('a')])).state, 'off');
    assert.equal(calls.length, 0);
  });
});
