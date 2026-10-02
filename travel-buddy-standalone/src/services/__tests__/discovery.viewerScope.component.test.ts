/**
 * services/discovery.ts — the viewer's token reaches the three Discovery reads,
 * and the device cache that holds their answers is per viewer.
 * census-discovery §50 (the client-correctness lane).
 *
 * THE DEFECTS
 * ===========
 * 1. `GET /api/discovery`, `/api/discovery/community` and `/api/discovery/counts`
 *    were fetched with NO Authorization header, while every other call in the
 *    file (search, suggest, feed) sent one. So every production serve was
 *    anonymous: the viewer's blocks (both directions), mutes, dismissals, age
 *    bounds and Layover gating never applied, no per-viewer ranking ran, and no
 *    serve telemetry was written.
 * 2. Once the token is sent, the answer is per viewer IN CONTENT — and the
 *    4-minute device cache was keyed (destination, category, radius, page) with
 *    no viewer term. User X's page, X's recommendation ids included, would be
 *    painted for user Y on the same phone; and a place the viewer had just
 *    dismissed, or whose author they had just blocked, would be re-shown from
 *    the cache for up to four minutes after the server stopped serving it.
 *
 * The negative paths the fix must hold: signed out, an expired token, a token
 * whose refresh fails, an account switch mid-session AND mid-request, and a
 * failed or refused response (never cached).
 *
 * THE TOKEN CHAIN IS REAL. `services/apiToken.ts` is not mocked: its Supabase
 * seam (`_setTestSupabase`) is, so the refresh-before-expiry logic that decides
 * which token is sent is the production logic.
 *
 * Run with: pnpm test:component
 */

// NOTE: intentionally exhaustive — the real Supabase client pulls react-native
// native internals that crash under jest-expo. apiToken's session reads go through
// its own `_setTestSupabase` seam below; blocks/mutes read only `isSupabaseConfigured`.
jest.mock('../../lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: true }));

import {
  getDiscoveryPlaces,
  getCachedDiscoveryPlaces,
  isDiscoveryCacheFresh,
  getCommunityPlaces,
  getDiscoveryCategoryCountsBatch,
  _resetDiscoveryClientCache,
  _discoveryClientCacheSizeForTests,
} from '../discovery.ts';
import { _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';
import {
  setDiscoveryViewerFromSession,
  currentDiscoveryScope,
  VIEWER_CHANGED_ERROR,
  _resetDiscoveryViewerScopeForTests,
} from '../discoveryViewerScope.ts';
import { blockUser, unblockUser } from '../blocks.ts';
import { muteUser, unmuteUser } from '../mutes.ts';
import { parseDiscoveryCandidate, whyNowPresentation } from '../../features/discovery/candidateProjection.ts';

const API_BASE = 'http://api.test';
const FILTERS = { radiusKm: 25, openNow: false, minRating: null };

/** A Supabase-shaped access token: a JWT whose `sub` is the user id. */
function jwt(sub: string, generation = 0): string {
  const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub, generation })}.signature`;
}

// ── The Supabase auth seam apiToken reads ─────────────────────────────────────

let session: { access_token: string; expires_at?: number } | null = null;
let refreshTo: { access_token: string } | null = null;
const refreshSession = jest.fn(async () => ({ data: { session: refreshTo } }));

const nowSec = () => Math.floor(Date.now() / 1000);
function signInAs(sub: string, generation = 0) {
  session = { access_token: jwt(sub, generation), expires_at: nowSec() + 3600 };
  refreshTo = null;
}
function signedOut() {
  session = null;
  refreshTo = null;
}

// ── fetch ─────────────────────────────────────────────────────────────────────

interface Call { url: string; init: RequestInit | undefined }
let calls: Call[];
/** Response body per path prefix; a function may return a promise to hold a request in flight. */
let respond: (url: string) => Promise<Response> | Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function page(...ids: string[]) {
  return { places: ids.map((id) => ({ id, name: `Place ${id}` })), total: ids.length, destination: 'Miami', cached: false };
}

function authOf(call: Call | undefined): string | undefined {
  const h = call?.init?.headers as Record<string, string> | undefined;
  return h?.Authorization;
}

const realFetch = global.fetch;
beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = API_BASE; });
afterAll(() => { global.fetch = realFetch; _resetTestSupabase(); });

beforeEach(() => {
  calls = [];
  refreshSession.mockClear();
  _resetDiscoveryViewerScopeForTests();
  _resetDiscoveryClientCache();
  _setTestSupabase({
    auth: {
      getSession: async () => ({ data: { session } }),
      refreshSession,
    },
  });
  respond = () => json(page('node/1'));
  global.fetch = jest.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(respond(String(url)));
  }) as unknown as typeof fetch;
});

// ── 1. The token reaches the three reads ──────────────────────────────────────

describe('the viewer\'s token reaches GET /discovery, /community and /counts', () => {
  it('signed in: GET /api/discovery carries Authorization: Bearer <the session token>', async () => {
    signInAs('user-x');
    await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    expect(calls[0].url).toContain('/api/discovery?');
    expect(authOf(calls[0])).toBe(`Bearer ${session!.access_token}`);
  });

  it('signed in: /community and /counts carry it too', async () => {
    signInAs('user-x');
    respond = (url) => json(url.includes('/counts') ? { counts: { food: 3 } } : { items: [], city: 'Cebu', total: 0 });
    await getCommunityPlaces('Cebu');
    await getDiscoveryCategoryCountsBatch('Cebu');
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/discovery/community', '/api/discovery/counts']);
    for (const c of calls) expect(authOf(c)).toBe(`Bearer ${session!.access_token}`);
  });

  it('signed out: all three are sent with NO Authorization header — anonymous, as the routes allow', async () => {
    signedOut();
    respond = (url) => json(url.includes('/counts') ? { counts: {} } : url.includes('/community') ? { items: [], city: 'Cebu', total: 0 } : page('node/1'));
    const placesRes = await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    await getCommunityPlaces('Cebu');
    await getDiscoveryCategoryCountsBatch('Cebu');
    expect(placesRes.ok).toBe(true);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      // Absent — not "Bearer null", not "Bearer ", not an empty string.
      expect(authOf(c)).toBeUndefined();
      expect(JSON.stringify(c.init ?? {})).not.toMatch(/Authorization/i);
    }
  });

  it('an EXPIRED token is refreshed first and the FRESH token is what is sent', async () => {
    session = { access_token: jwt('user-x', 0), expires_at: nowSec() - 5 };
    refreshTo = { access_token: jwt('user-x', 1) };
    await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(authOf(calls[0])).toBe(`Bearer ${jwt('user-x', 1)}`);
    expect(authOf(calls[0])).not.toBe(`Bearer ${jwt('user-x', 0)}`);
  });

  it('an expired token whose refresh FAILS is not sent: the read goes anonymous', async () => {
    session = { access_token: jwt('user-x', 0), expires_at: nowSec() - 5 };
    refreshTo = null;
    await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    expect(authOf(calls[0])).toBeUndefined();
    expect(currentDiscoveryScope().viewer).toBe('anon');
  });
});

// ── 2. The device page cache is per viewer ────────────────────────────────────

describe('the 4-minute device cache never paints one viewer\'s page for another', () => {
  async function cacheAsX() {
    signInAs('user-x');
    respond = () => json(page('node/x-only'));
    await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    // Positive control: X's own page IS cached and readable for X.
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)?.places.map((p) => p.id)).toEqual(['node/x-only']);
  }

  it('an account switch (the auth event) makes X\'s page unreadable for Y at once', async () => {
    await cacheAsX();
    setDiscoveryViewerFromSession('user-y');
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).toBeNull();
    expect(isDiscoveryCacheFresh('Miami', 'for_you', 25, 1)).toBe(false);
  });

  it('after the switch X\'s pages are not even HELD in memory — not merely unreadable', async () => {
    await cacheAsX();
    expect(_discoveryClientCacheSizeForTests()).toBe(1);
    setDiscoveryViewerFromSession('user-y');
    expect(_discoveryClientCacheSizeForTests()).toBe(0);
  });

  it('sign-out makes X\'s page unreadable for the anonymous viewer', async () => {
    await cacheAsX();
    setDiscoveryViewerFromSession(null);
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).toBeNull();
  });

  it('Y\'s own first request clears X\'s pages even when no auth event was seen', async () => {
    await cacheAsX();
    signInAs('user-y');
    respond = () => json(page('node/y-only'));
    await getDiscoveryPlaces('Miami', 'food', FILTERS);
    // X's for_you page is gone; Y's food page is there.
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).toBeNull();
    expect(getCachedDiscoveryPlaces('Miami', 'food', 25, 1)?.places.map((p) => p.id)).toEqual(['node/y-only']);
    // And switching back to X does not resurrect X's page from anywhere.
    setDiscoveryViewerFromSession('user-x');
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).toBeNull();
  });

  it('an ANONYMOUS page is not painted for X after sign-in — it carries none of X\'s blocks', async () => {
    signedOut();
    respond = () => json(page('node/anon'));
    await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).not.toBeNull();
    setDiscoveryViewerFromSession('user-x');
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).toBeNull();
  });

  it('CONTROL: the same viewer after a token refresh keeps the cache — the key is the viewer, not the token string', async () => {
    await cacheAsX();
    // The refreshed token names the same user.
    session = { access_token: jwt('user-x', 7), expires_at: nowSec() + 3600 };
    respond = () => json(page('node/other'));
    await getDiscoveryPlaces('Miami', 'food', FILTERS);
    expect(authOf(calls[calls.length - 1])).toBe(`Bearer ${jwt('user-x', 7)}`);
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)?.places.map((p) => p.id)).toEqual(['node/x-only']);
  });

  it('an account switch MID-REQUEST: X\'s answer is discarded — not returned, not cached', async () => {
    signInAs('user-x');
    let release!: (r: Response) => void;
    respond = () => new Promise<Response>((r) => { release = r; });
    const inFlight = getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    // Let the request go out as X.
    for (let i = 0; i < 10 && calls.length === 0; i++) await Promise.resolve();
    expect(authOf(calls[0])).toBe(`Bearer ${jwt('user-x')}`);

    setDiscoveryViewerFromSession('user-y');
    release(json(page('node/x-only')));
    const res = await inFlight;

    expect(res).toEqual({ ok: false, error: VIEWER_CHANGED_ERROR });
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).toBeNull();
    setDiscoveryViewerFromSession('user-x');
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).toBeNull();
  });

  it('the community read: an account switch mid-request discards X\'s bylines', async () => {
    signInAs('user-x');
    let release!: (r: Response) => void;
    respond = () => new Promise<Response>((r) => { release = r; });
    const inFlight = getCommunityPlaces('Cebu');
    for (let i = 0; i < 10 && calls.length === 0; i++) await Promise.resolve();
    setDiscoveryViewerFromSession('user-y');
    release(json({ items: [{ id: 'g1', submittedBy: { id: 's1', name: 'Real Name', displayName: 'Real Name', handle: 's1', avatarUrl: null } }], city: 'Cebu', total: 1 }));
    expect(await inFlight).toEqual({ ok: false, error: VIEWER_CHANGED_ERROR });
  });
});

// ── 3. Block, mute and dismissal invalidate ───────────────────────────────────

describe('a block, unblock, mute or unmute clears every cached page', () => {
  async function cacheWithBlockedAuthorsPlace() {
    signInAs('user-x');
    respond = () => json(page('db/by-author-z'));
    await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).not.toBeNull();
    respond = () => json({ ok: true });
  }

  it.each([
    ['blockUser', () => blockUser('author-z')],
    ['unblockUser', () => unblockUser('author-z')],
    ['muteUser', () => muteUser('author-z')],
    ['unmuteUser', () => unmuteUser('author-z')],
  ])('%s succeeds ⇒ the place is not re-shown from the cache', async (_name, act) => {
    await cacheWithBlockedAuthorsPlace();
    const res = await act();
    expect(res.ok).toBe(true);
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).toBeNull();
  });

  it('CONTROL: a FAILED block leaves the cache alone — nothing changed on the server', async () => {
    await cacheWithBlockedAuthorsPlace();
    respond = () => json({ message: 'nope' }, 500);
    const res = await blockUser('author-z');
    expect(res.ok).toBe(false);
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).not.toBeNull();
  });

  it('a page IN FLIGHT when the block landed is returned but NOT cached — it may predate the block', async () => {
    signInAs('user-x');
    let release!: (r: Response) => void;
    respond = () => new Promise<Response>((r) => { release = r; });
    const inFlight = getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    for (let i = 0; i < 10 && calls.length === 0; i++) await Promise.resolve();

    respond = () => json({ ok: true });
    await blockUser('author-z');
    release(json(page('db/by-author-z')));
    const res = await inFlight;

    expect(res.ok).toBe(true); // the viewer's own answer — shown
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).toBeNull(); // — never replayed
  });

  it('that stale in-flight page does not EVICT the fresh page fetched after the block', async () => {
    signInAs('user-x');
    let releaseStale!: (r: Response) => void;
    respond = () => new Promise<Response>((r) => { releaseStale = r; });
    const stale = getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    for (let i = 0; i < 10 && calls.length === 0; i++) await Promise.resolve();

    respond = () => json({ ok: true });
    await blockUser('author-z');
    respond = () => json(page('node/fresh'));
    await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)?.places.map((p) => p.id)).toEqual(['node/fresh']);

    releaseStale(json(page('db/by-author-z')));
    await stale;
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)?.places.map((p) => p.id)).toEqual(['node/fresh']);
  });
});

// ── 4. Failed and refused answers are never cached, for a signed-in viewer ─────

describe('a failed or refused answer is never cached', () => {
  it('an HTTP failure is not cached', async () => {
    signInAs('user-x');
    respond = () => json({}, 503);
    const res = await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    expect(res.ok).toBe(false);
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).toBeNull();
  });

  it('a coverage:"nothing" refusal is not cached', async () => {
    signInAs('user-x');
    respond = () => json({
      places: [], total: 0, destination: 'Miami', cached: false,
      refusal: { class: 'transient_db', code: 'x', route: 'GET /discovery', coverage: 'nothing' },
    });
    const res = await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    expect(res.ok).toBe(true);
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).toBeNull();
  });
});

// ── 5. DSV2-04 end to end: the receipt instant survives the device cache ──────

describe('why-now expiry survives the device cache', () => {
  it('a cached page repainted after its why-now horizon renders the claim stale, judged at the device clock', async () => {
    signInAs('user-x');
    respond = () => json({
      ...page(),
      places: [{
        id: 'node/1', name: 'Busy bar',
        candidate: {
          id: 'node/1', whyNow: ['crowd_busy'], whyForUser: [], rankedBy: 'none', confidence: 0.6,
          freshness: { state: 'fresh', ageMs: 0, servedFrom: 'miss' }, truthClass: 'observed',
          provenance: null, reasons: [], whyNowValidForMs: 60_000,
        },
      }],
    });
    const receivedAt = Date.now();
    await getDiscoveryPlaces('Miami', 'for_you', FILTERS);

    const cached = getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)!;
    const candidate = parseDiscoveryCandidate(cached.places[0].candidate);
    // Stamped at receipt on THIS device…
    expect(candidate!.whyNowExpiresAtMs).toBeGreaterThanOrEqual(receivedAt + 60_000);
    expect(candidate!.whyNowExpiresAtMs).toBeLessThanOrEqual(Date.now() + 60_000);
    // …so a repaint two minutes later, from the cache, is past the horizon.
    const later = whyNowPresentation(candidate, receivedAt + 2 * 60_000 + 1_000);
    expect(later.stale).toBe(true);
    // And a repaint inside the window is still current.
    expect(whyNowPresentation(candidate, receivedAt).stale).toBe(false);
  });
});
