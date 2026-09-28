/**
 * Media §39 offline / degraded mode (MD295–MD301) and §40 services/mediaCache.ts
 * (MD325): the cache's safety rules, the cache-through scopes over the real
 * projection fetchers, the warm-up, and the hydration fallback that makes a
 * cached private image renderable with no network.
 *
 * The projection fetchers run for real (mediaProjection.ts over a fake
 * `fetch`); the cache runs for real over in-memory storage and files.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MediaCache,
  SCOPE_POLICY,
  MAX_IMAGE_BYTES_TOTAL,
  decayFreshness,
  scrubCoordinates,
  _setMediaCache,
  _failMediaCacheLoad,
  type CacheEnv,
} from '../mediaCache.ts';
import {
  collectImageRefs,
  crewSlice,
  experiencesOffline,
  gemsOffline,
  peopleOffline,
  placeViewOffline,
  prepareOfflineMedia,
} from '../mediaOffline.ts';
import { installMediaOfflineWarmup, tripsWorthCaching, warmOfflineMedia } from '../mediaOfflineDevice.ts';
import { _setTestFreshToken, _clearTestFreshToken } from '../../../features/media/services/mediaProjection.ts';
import { hydrateMediaUrls } from '../../mediaUrl.ts';
import { _resetBatchSignCache, _setTestSignTokenProvider } from '../../../lib/batchSignMedia.ts';

// ── Fakes ─────────────────────────────────────────────────────────────────────

function fakeEnv(opts: { account?: () => string | null; now?: () => number; deny?: Set<string> } = {}) {
  const store = new Map<string, string>();
  const files = new Map<string, number>();
  const downloads: string[] = [];
  let clock = 1_000_000;
  const env: CacheEnv & { store: typeof store; fileMap: typeof files; downloads: string[]; tick(ms: number): void } = {
    store,
    fileMap: files,
    downloads,
    tick(ms: number) { clock += ms; },
    storage: {
      getItem: async (k) => store.get(k) ?? null,
      setItem: async (k, v) => { store.set(k, v); },
      removeItem: async (k) => { store.delete(k); },
    },
    files: {
      dirFor: (a) => `file:///docs/media-offline/${a}/`,
      download: async (url, to) => { downloads.push(url); files.set(to, 1000); return 1000; },
      remove: async (uri) => { files.delete(uri); },
    },
    accountId: async () => (opts.account ? opts.account() : 'acct-A'),
    now: () => (opts.now ? opts.now() : clock),
    sign: async (refs) => Object.fromEntries(refs.map((r) => [r, opts.deny?.has(r) ? null : `https://signed.test/${r}?t=1`])),
  };
  return env;
}

const MIN = 60_000;

// ── Pure rules ────────────────────────────────────────────────────────────────

describe('MD325 — what a cached payload may claim about itself', () => {
  it('FRESHNESS ONLY DECAYS: nothing served from the cache reads live, and every age grows', () => {
    const payload = {
      stateLabel: 'Getting busier',
      consensus: { state: 'mixed', uncertaintyLabel: 'Mixed reports — conditions may be changing' } as unknown,
      live: true,
      liveClaims: [{ x: 1 }],
      heroMedia: [
        { id: 'a', freshness: 'live', ageMinutes: 2, freshnessLabel: 'Updated 2m ago' },
        { id: 'b', freshness: 'fresh', ageMinutes: 30 },
        { id: 'c', freshness: 'historical', ageMinutes: 5 },
        { id: 'd', freshness: 'live' },
      ],
    };
    const out = decayFreshness(payload, 90);
    assert.equal(out.stateLabel, null, 'a live crowd state is never served from a cache');
    assert.equal(out.consensus, null, 'a §18 consensus is about the fresh window — never replayed from a cache');
    assert.equal(out.live, false);
    assert.deepEqual(out.liveClaims, []);
    assert.equal(out.heroMedia[0]!.freshness, 'recent', '2m + 90m of cache time is recent, not live');
    assert.equal(out.heroMedia[0]!.ageMinutes, 92);
    assert.equal(out.heroMedia[0]!.freshnessLabel, 'Updated 1h ago');
    assert.equal(out.heroMedia[1]!.freshness, 'recent');
    assert.equal(out.heroMedia[2]!.freshness, 'historical', 'a class is never UPGRADED by recomputation');
    assert.equal(out.heroMedia[3]!.freshness, 'fresh', 'live with no age of its own is still demoted');
    assert.equal(payload.heroMedia[0]!.freshness, 'live', 'the input is not mutated');
  });

  it('NO COORDINATES are ever stored, at any depth', () => {
    const out = scrubCoordinates({ a: { lat: 1, lng: 2, label: 'x', inner: [{ latitude: 3, longitude: 4, public_lat: 5, id: 'k' }] }, geometry: {} });
    assert.deepEqual(out, { a: { label: 'x', inner: [{ id: 'k' }] } });
  });

  it('collects cover images, never a video file', () => {
    const refs = collectImageRefs({
      heroMedia: [
        { mediaType: 'video', url: 'post-media/v.mp4', thumbnailUrl: 'post-media/v.mp4.poster.jpg' },
        { mediaType: 'video', url: 'post-media/w.mp4', thumbnailUrl: null },
        { mediaType: 'image', url: 'post-media/p.jpg', thumbnailUrl: null },
      ],
    });
    assert.deepEqual(refs, ['post-media/v.mp4.poster.jpg', 'post-media/p.jpg']);
  });
});

describe('MD325 — the cache store: scoped, bounded, account-isolated, revocable', () => {
  it('round-trips a payload with its age, re-aged on the way out', async () => {
    const env = fakeEnv();
    const c = new MediaCache(env);
    await c.put('place_perspectives', 'p1', { heroMedia: [{ freshness: 'fresh', ageMinutes: 5 }] }, ['post-media/a.jpg']);
    env.tick(120 * MIN);
    const hit = await c.get<{ heroMedia: Array<{ freshness: string; ageMinutes: number }> }>('place_perspectives', 'p1');
    assert.ok(hit);
    assert.equal(Math.round(hit.ageMinutes), 120);
    assert.equal(hit.payload.heroMedia[0]!.ageMinutes, 125);
    assert.equal(hit.payload.heroMedia[0]!.freshness, 'recent');
    assert.equal(await c.localFileFor('post-media/a.jpg') !== null, true);
  });

  it('each scope expires on its own clock (a place view after a day; a trip after two weeks)', async () => {
    const env = fakeEnv();
    const c = new MediaCache(env);
    await c.put('place_perspectives', 'p', { a: 1 });
    await c.put('trip_media', 't', { a: 1 });
    env.tick(SCOPE_POLICY.place_perspectives.ttlMs + MIN);
    assert.equal(await c.get('place_perspectives', 'p'), null);
    assert.ok(await c.get('trip_media', 't'));
  });

  it('a scope keeps at most its cap, evicting the LEAST RECENTLY READ first', async () => {
    const env = fakeEnv();
    const c = new MediaCache(env);
    const cap = SCOPE_POLICY.hidden_gems.maxEntries;
    for (let i = 0; i < cap; i++) { await c.put('hidden_gems', `g${i}`, { i }); env.tick(MIN); }
    await c.get('hidden_gems', 'g0'); // g0 is now the most recently read
    env.tick(MIN);
    await c.put('hidden_gems', 'new', { i: 99 });
    assert.ok(await c.get('hidden_gems', 'g0'), 'the recently-read entry survives');
    assert.equal(await c.get('hidden_gems', 'g1'), null, 'the least-recently-read one went');
  });

  it('the image byte budget is global, and images are dropped with their entries', async () => {
    const env = fakeEnv();
    const big = { ...env.files!, download: async (_u: string, to: string) => { env.fileMap.set(to, MAX_IMAGE_BYTES_TOTAL / 2); return MAX_IMAGE_BYTES_TOTAL / 2; } };
    const c = new MediaCache({ ...env, files: big });
    await c.put('trip_media', 't1', {}, ['post-media/1.jpg']);
    env.tick(MIN);
    await c.put('trip_media', 't2', {}, ['post-media/2.jpg']);
    env.tick(MIN);
    await c.put('trip_media', 't3', {}, ['post-media/3.jpg']);
    const inv = await c.inventory();
    assert.deepEqual(inv.map((e) => e.key).sort(), ['t2', 't3']);
    assert.equal(env.fileMap.size, 2, 'the evicted entry took its file with it');
  });

  it('an image the server would not sign for this viewer is never stored', async () => {
    const env = fakeEnv({ deny: new Set(['post-media/secret.jpg']) });
    const c = new MediaCache(env);
    await c.put('crew_media', 'crew', {}, ['post-media/ok.jpg', 'post-media/secret.jpg']);
    assert.equal(await c.localFileFor('post-media/secret.jpg'), null);
    assert.ok(await c.localFileFor('post-media/ok.jpg'));
  });

  it('ACCOUNT-ISOLATED and fail-closed: another account reads nothing; no account writes nothing', async () => {
    let who: string | null = 'acct-A';
    const env = fakeEnv({ account: () => who });
    const c = new MediaCache(env);
    await c.put('saved_places', 'p', { mine: true }, ['post-media/a.jpg']);
    who = 'acct-B';
    assert.equal(await c.get('saved_places', 'p'), null);
    assert.equal(await c.localFileFor('post-media/a.jpg'), null);
    who = null;
    const before = env.store.size;
    await c.put('saved_places', 'q', { x: 1 });
    assert.equal(env.store.size, before);
    assert.equal(await c.get('saved_places', 'p'), null);
  });

  it('a REVOCATION the device is told about deletes the copy (forgetRef), from every entry', async () => {
    const env = fakeEnv();
    const c = new MediaCache(env);
    await c.put('place_perspectives', 'p1', {}, ['post-media/x.jpg']);
    await c.put('saved_places', 'p1', {}, ['post-media/x.jpg']);
    await c.forgetRef('post-media/x.jpg');
    assert.equal(await c.localFileFor('post-media/x.jpg'), null);
    assert.equal(env.fileMap.size, 0);
  });

  it('coordinates in a payload never reach storage', async () => {
    const env = fakeEnv();
    const c = new MediaCache(env);
    await c.put('trip_media', 't', { placeLabel: 'Café', lat: 16.06, lng: 108.2 });
    assert.equal([...env.store.values()].some((v) => v.includes('108.2')), false);
  });
});

// ── The scopes over the real fetchers ─────────────────────────────────────────

type Handler = (path: string) => { status: number; body?: unknown } | 'throw';
let handler: Handler;
const realFetch = globalThis.fetch;

function useFakeNetwork() {
  (globalThis as { fetch: unknown }).fetch = async (url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const r = handler(path);
    if (r === 'throw') throw new Error('Network request failed');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      headers: { get: () => null },
    };
  };
}

function placeBody(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    placeName: 'An Thuong 2',
    stateLabel: 'Busy',
    currentPicture: { strength: 'strong', updatedAt: null, ageMinutes: 3, perspectiveCount: 2, contributorCount: 2, sourceCount: 2, trend: 'steady' },
    groups: [],
    heroMedia: [
      { id: 'm1', mediaType: 'image', url: 'post-media/u/1.jpg', thumbnailUrl: 'post-media/u/1.thumb.jpg', freshness: 'fresh', ageMinutes: 3, lat: 16.1 },
      { id: 'm2', mediaType: 'video', url: 'post-media/u/2.mp4', thumbnailUrl: 'post-media/u/2.mp4.poster.jpg', freshness: 'fresh', ageMinutes: 4 },
    ],
    ...extra,
  };
}

const PLACE = '11111111-1111-4111-8111-111111111111';
const TRIP = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';

describe('MD295–MD301 — each §39 scope is filled online and served, aged and labelled, offline', () => {
  let env: ReturnType<typeof fakeEnv>;
  beforeEach(() => {
    env = fakeEnv();
    _setMediaCache(new MediaCache(env));
    _setTestFreshToken('t');
    useFakeNetwork();
  });
  afterEach(() => {
    _setMediaCache(null);
    _clearTestFreshToken();
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it('a cache that cannot even load never takes the lens down: the live answer is still returned', async () => {
    _failMediaCacheLoad(new Error('storage unavailable'));
    try {
      handler = () => ({ status: 200, body: placeBody(PLACE) });
      const r = await placeViewOffline(PLACE);
      assert.equal(r.ok && r.data?.placeId, PLACE);
    } finally {
      _failMediaCacheLoad(null);
    }
  });

  it('MD299 place perspectives: online → stored with its images; offline → served with a Cached label, never live', async () => {
    handler = () => ({ status: 200, body: placeBody(PLACE) });
    const online = await placeViewOffline(PLACE);
    assert.equal(online.ok && online.offline, undefined, 'a live answer carries no cached label');
    await settle();
    assert.deepEqual(env.downloads.map((u) => u.replace('https://signed.test/', '').replace('?t=1', '')).sort(), [
      'post-media/u/1.thumb.jpg', 'post-media/u/2.mp4.poster.jpg',
    ], 'covers and posters are stored; the video file is not');
    env.tick(3 * 60 * MIN);
    handler = () => 'throw';
    const offline = await placeViewOffline(PLACE);
    assert.equal(offline.ok, true);
    assert.equal(offline.ok && offline.offline?.label, 'Cached · updated 3h ago');
    assert.equal(offline.ok && offline.data?.stateLabel, null, 'the live crowd label is not served from cache');
    assert.equal(offline.ok && offline.data?.heroMedia[0]!.freshness, 'recent');
  });

  it('a server ANSWER of "nothing here" deletes the cached copy; an auth failure is never covered by the cache', async () => {
    handler = () => ({ status: 200, body: placeBody(PLACE) });
    await placeViewOffline(PLACE);
    await settle();
    handler = () => ({ status: 401, body: {} });
    const auth = await placeViewOffline(PLACE);
    assert.equal(auth.ok, false, 'a 401 is not an outage');
    handler = () => ({ status: 404, body: {} });
    await placeViewOffline(PLACE);
    await settle();
    handler = () => 'throw';
    const after = await placeViewOffline(PLACE);
    assert.equal(after.ok, false, 'the copy went when the server said it was gone');
  });

  it('MD296 saved places: a pre-warmed saved place is there offline though it was never opened; a non-canonical id is skipped', async () => {
    handler = (p) => (p.includes(PLACE) ? { status: 200, body: placeBody(PLACE) } : { status: 500 });
    const warm = await prepareOfflineMedia({ savedPlaceIds: [PLACE, 'fsq:12345'] });
    assert.deepEqual(warm, { stored: 1, skipped: 1 });
    assert.deepEqual((await (await import('../mediaCache.ts')).getMediaCache().then((c) => c.inventory())).map((e) => e.scope), ['saved_places']);
    handler = () => 'throw';
    const r = await placeViewOffline(PLACE);
    assert.equal(r.ok && r.offline !== undefined, true);
  });

  it('MD295 + MD298: a trip is filed as trip media, an event as event checkpoint visuals, and a mixed list is labelled by its OLDEST member', async () => {
    handler = (p) =>
      p.includes(TRIP) ? { status: 200, body: { id: TRIP, kind: 'trip', tripId: TRIP, title: 'Vietnam', heroMedia: [{ id: 'x', mediaType: 'image', thumbnailUrl: 'post-media/t.jpg', freshness: 'fresh' }] } }
      : p.includes(EVENT) ? { status: 200, body: { id: EVENT, kind: 'event', eventId: EVENT, title: 'Beach Festival', heroMedia: [] } }
      : { status: 404 };
    await experiencesOffline([TRIP]);
    env.tick(60 * MIN);
    await experiencesOffline([EVENT]);
    await settle();
    const c = await (await import('../mediaCache.ts')).getMediaCache();
    const inv = await c.inventory();
    assert.equal(inv.find((e) => e.key === TRIP)?.scope, 'trip_media');
    assert.equal(inv.find((e) => e.key === EVENT)?.scope, 'event_checkpoints');
    env.tick(60 * MIN);
    handler = () => 'throw';
    const r = await experiencesOffline([TRIP, EVENT]);
    assert.equal(r.ok && r.data.length, 2);
    assert.equal(r.ok && r.offline?.label, 'Cached · updated 2h ago', 'the older member decides the label');
  });

  it('MD301 crew media: only the Trip Crew groups are ever stored; offline the lens shows exactly those', async () => {
    const people = {
      generatedAt: '2026-09-26T00:00:00Z',
      people: [
        { contributor: { id: 'c1', name: 'Crewmate' }, relation: 'trip_crew', perspectiveCount: 1, freshness: 'fresh', media: [{ id: 'q', mediaType: 'image', thumbnailUrl: 'post-media/crew.jpg' }] },
        { contributor: { id: 'f1', name: 'Followed' }, relation: 'followed', perspectiveCount: 1, freshness: 'fresh', media: [{ id: 'r', mediaType: 'image', thumbnailUrl: 'post-media/followed.jpg' }] },
      ],
    };
    handler = () => ({ status: 200, body: people });
    const online = await peopleOffline();
    assert.equal(online.ok && online.data.people.length, 2, 'online, the lens is whole');
    await settle();
    assert.equal([...env.store.values()].some((v) => v.includes('Followed')), false, 'followed groups are not §39 content and never stored');
    handler = () => 'throw';
    const off = await peopleOffline();
    assert.deepEqual(off.ok && off.data.people.map((g) => g.relation), ['trip_crew']);
    assert.equal(crewSlice({ generatedAt: null, people: [] }).people.length, 0);
  });

  it('MD297 hidden gems where permitted: a gem the server declined to name is never copied onto the device', async () => {
    const gem = (gemId: string, name: string | null) => ({
      gemId, name, placeId: null, category: 'viewpoint', neighborhood: 'Son Tra', city: 'Da Nang', country: 'VN',
      state: 'confirmed', confidence: { score: 0.8, band: 'high' }, contributionCounts: {}, verificationLevel: null,
      lastUpdatedAt: '2026-09-26T00:00:00Z', imageUrl: 'post-media/cove.jpg',
    });
    handler = () => ({ status: 200, body: {
      generatedAt: '2026-09-26T00:00:00Z', city: 'Da Nang', determined: true, undetermined: [],
      gems: [gem('g1', 'Quiet cove'), gem('g2-withheld', null)],
    } });
    const online = await gemsOffline({ city: 'Da Nang' });
    assert.equal(online.ok && online.data.gems.length, 2, 'online, the lens is whole');
    await settle();
    assert.equal([...env.store.values()].some((v) => v.includes('g2-withheld')), false, 'an unnamed gem is never stored');
    handler = () => 'throw';
    const off = await gemsOffline({ city: 'Da Nang' });
    assert.deepEqual(off.ok && off.data.gems.map((g) => g.gemId), ['g1']);
    assert.equal(off.ok && off.data.total, 1);
  });

  it('MD297 an UNREADABLE gem list is an outage: the cache is served and kept, never cleared as "no gems here"', async () => {
    const g1 = { gemId: 'g1', name: 'Quiet cove', placeId: null, category: null, neighborhood: null, city: 'Da Nang', country: null,
      state: 'confirmed', confidence: { score: 0.8, band: 'high' }, contributionCounts: {}, verificationLevel: null, lastUpdatedAt: null, imageUrl: null };
    handler = () => ({ status: 200, body: { generatedAt: 'x', city: 'Da Nang', determined: true, undetermined: [], gems: [g1] } });
    await gemsOffline({ city: 'Da Nang' });
    await settle();
    handler = () => ({ status: 200, body: { generatedAt: 'y', city: 'Da Nang', determined: false, undetermined: ['gems'], gems: [] } });
    const r = await gemsOffline({ city: 'Da Nang' });
    assert.equal(r.ok, true, 'served from cache');
    assert.ok(r.ok && r.offline, 'labelled as cached, not presented as live');
    assert.deepEqual(r.ok && r.data.gems.map((g) => g.gemId), ['g1']);
    await settle();
    assert.equal([...env.store.values()].some((v) => v.includes('Quiet cove')), true, 'the cache was not cleared');
    // A genuinely empty, READ list does clear it.
    handler = () => ({ status: 200, body: { generatedAt: 'z', city: 'Da Nang', determined: true, undetermined: [], gems: [] } });
    await gemsOffline({ city: 'Da Nang' });
    await settle();
    assert.equal([...env.store.values()].some((v) => v.includes('Quiet cove')), false, 'an empty READ list clears the scope');
  });
});

// ── The image path: a cached private image renders with no network ────────────

describe('MD325 — hydration serves the cached file only when signing is UNREACHABLE, and purges on DENIAL', () => {
  let env: ReturnType<typeof fakeEnv>;
  beforeEach(async () => {
    env = fakeEnv();
    const c = new MediaCache(env);
    _setMediaCache(c);
    await c.put('place_perspectives', PLACE, {}, ['post-media/u/1.jpg']);
    _resetBatchSignCache();
    _setTestSignTokenProvider(async () => 't');
  });
  afterEach(() => {
    _setMediaCache(null);
    _setTestSignTokenProvider(null);
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  it('unreachable sign endpoint → the local file', async () => {
    (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
    const r = await hydrateMediaUrls(['post-media/u/1.jpg']);
    assert.match(String(r['post-media/u/1.jpg']), /^file:\/\/\/docs\/media-offline\/acct-A\//);
  });

  it('the server DENIES it → null, and the cached copy is deleted', async () => {
    (globalThis as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200, json: async () => ({ signed: { 'post-media/u/1.jpg': null }, ttlSeconds: 3600 }) });
    const r = await hydrateMediaUrls(['post-media/u/1.jpg']);
    assert.equal(r['post-media/u/1.jpg'], null);
    await new Promise((res) => setTimeout(res, 5));
    const c = await (await import('../mediaCache.ts')).getMediaCache();
    assert.equal(await c.localFileFor('post-media/u/1.jpg'), null);
  });

  it('online and allowed → the SIGNED url, not the local copy (authorization is re-checked every time)', async () => {
    (globalThis as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200, json: async () => ({ signed: { 'post-media/u/1.jpg': 'https://sb/signed?x' }, ttlSeconds: 3600 }) });
    const r = await hydrateMediaUrls(['post-media/u/1.jpg']);
    assert.equal(r['post-media/u/1.jpg'], 'https://sb/signed?x');
  });
});

// ── Warm-up ───────────────────────────────────────────────────────────────────

describe('§39 warm-up — the user\'s saved places and current trips are cached before they are needed', () => {
  it('keeps current and upcoming trips, drops finished and cancelled ones', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    const ids = tripsWorthCaching([
      { id: 'past', startDate: '2026-08-01', endDate: '2026-08-10', status: 'completed' },
      { id: 'now', startDate: '2026-09-20', endDate: '2026-09-30', status: 'active' },
      { id: 'soon', startDate: '2026-10-05', endDate: null, status: 'planning' },
      { id: 'off', startDate: '2026-10-01', endDate: '2026-10-09', status: 'cancelled' },
      { id: 'yesterday', startDate: '2026-09-20', endDate: '2026-09-25T20:00:00Z', status: 'active' },
    ], now);
    assert.deepEqual(ids, ['now', 'soon', 'yesterday']);
  });

  it('passes saved places and trips to the warmer, and a failing source contributes nothing', async () => {
    const seen: unknown[] = [];
    const out = await warmOfflineMedia({
      savedPlaceIds: async () => [PLACE],
      trips: async () => { throw new Error('offline'); },
      now: () => 0,
      prepare: async (ctx) => { seen.push(ctx); return { stored: 1, skipped: 0 }; },
    });
    assert.deepEqual(seen, [{ savedPlaceIds: [PLACE], tripIds: [] }]);
    assert.deepEqual(out, { stored: 1, skipped: 0 });
  });

  it('runs at install and on foreground, at most once per 30 minutes', async () => {
    let t = 0;
    let runs = 0;
    let listener: ((s: string) => void) | null = null;
    const stop = installMediaOfflineWarmup(
      { addEventListener: (_e, l) => { listener = l; return { remove: () => { listener = null; } }; } },
      { savedPlaceIds: async () => [], trips: async () => [], now: () => t, prepare: async () => { runs++; return { stored: 0, skipped: 0 }; } },
    );
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(runs, 1);
    t += 10 * MIN;
    listener!('active');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(runs, 1, 'throttled');
    t += 25 * MIN;
    listener!('active');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(runs, 2);
    stop();
    assert.equal(listener, null);
  });
});

// ── census-media §24 (Lane E): Map thumbnails (MD300) ─────────────────────────

import { mediaMapOffline } from '../mediaOffline.ts';

describe('MD300 — Map thumbnails: the map\'s clusters and their server-chosen covers, cached per city', () => {
  let env: ReturnType<typeof fakeEnv>;
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const strip = (u: string) => u.replace('https://signed.test/', '').replace('?t=1', '');
  const A = '41444444-4444-4444-8444-444444444444';
  const B = '42444444-4444-4444-8444-444444444444';
  const mapBody = (extra: Record<string, unknown> = {}) => ({
    generatedAt: '2026-09-26T00:00:00Z',
    totalPerspectives: 3,
    clusters: [
      { placeId: A, label: 'An Thuong', perspectiveCount: 2, freshness: 'fresh',
        coverMedia: [{ id: 'c1', mediaType: 'image', url: 'post-media/u/c1.jpg', thumbnailUrl: 'post-media/u/c1.thumb.jpg',
          freshness: 'fresh', capturedAt: new Date(Date.now() - 5 * MIN).toISOString() }] },
      { placeId: B, label: 'My Khe', perspectiveCount: 1, freshness: 'recent',
        coverMedia: [{ id: 'v1', mediaType: 'video', url: 'post-media/u/v1.mp4', thumbnailUrl: 'post-media/u/v1.mp4.poster.jpg', freshness: 'recent' }] },
    ],
    ...extra,
  });
  beforeEach(() => {
    env = fakeEnv();
    _setMediaCache(new MediaCache(env));
    _setTestFreshToken('t');
    useFakeNetwork();
  });
  afterEach(() => {
    _setMediaCache(null);
    _clearTestFreshToken();
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  it('online → stored under map_thumbnails with ONLY the covers the server chose; offline → served, aged, labelled, never live', async () => {
    handler = (p) => (p.startsWith('/api/media/map') ? { status: 200, body: mapBody() } : { status: 404 });
    const online = await mediaMapOffline({ city: 'Da Nang' });
    assert.equal(online.ok && online.offline, undefined, 'a live answer carries no cached label');
    await settle();
    const inv = await (await import('../mediaCache.ts')).getMediaCache().then((c) => c.inventory());
    assert.deepEqual(inv.map((e) => [e.scope, e.key, e.images]), [['map_thumbnails', 'Da Nang', 2]]);
    assert.deepEqual(
      env.downloads.map(strip).sort(),
      ['post-media/u/c1.thumb.jpg', 'post-media/u/v1.mp4.poster.jpg'],
      'the covers and the poster; never the video file, never an image the server did not choose',
    );
    env.tick(3 * 60 * MIN);
    handler = () => 'throw';
    const off = await mediaMapOffline({ city: 'Da Nang' });
    assert.ok(off.ok);
    assert.equal(off.offline?.label, 'Cached · updated 3h ago');
    const a = off.data.clusters.find((c) => c.placeId === A)!;
    assert.equal(a.cover?.id, 'c1');
    assert.equal(a.freshness, 'recent', 'a "fresh" pin three hours in the cache reads "recent"');
    assert.equal(a.cover?.freshness, 'recent');
    assert.equal(JSON.stringify(off.data).includes('"live"'), false, 'nothing served from here reads live');
  });

  it('a cover the signer refuses for this viewer is never written to the device', async () => {
    env = fakeEnv({ deny: new Set(['post-media/u/c1.thumb.jpg']) });
    _setMediaCache(new MediaCache(env));
    handler = () => ({ status: 200, body: mapBody() });
    await mediaMapOffline({ city: 'Da Nang' });
    await settle();
    assert.deepEqual(env.downloads.map(strip), ['post-media/u/v1.mp4.poster.jpg']);
  });

  it('a server ANSWER of "no clusters here" deletes the stored map; an auth failure is never covered by it', async () => {
    handler = () => ({ status: 200, body: mapBody() });
    await mediaMapOffline({ city: 'Da Nang' });
    await settle();
    handler = () => ({ status: 401, body: {} });
    const auth = await mediaMapOffline({ city: 'Da Nang' });
    assert.equal(auth.ok, false, 'a 401 is not an outage');
    handler = () => ({ status: 200, body: mapBody({ clusters: [] }) });
    await mediaMapOffline({ city: 'Da Nang' });
    await settle();
    handler = () => 'throw';
    const gone = await mediaMapOffline({ city: 'Da Nang' });
    assert.equal(gone.ok, false, 'the stored map went when the server said there was nothing here');
  });

  it('the scope is §39\'s "Map thumbnails", short-lived like the perspectives its pins stand for', () => {
    assert.equal(SCOPE_POLICY.map_thumbnails.requirement, 'Map thumbnails');
    assert.ok(SCOPE_POLICY.map_thumbnails.ttlMs <= 24 * 60 * MIN);
  });
});
