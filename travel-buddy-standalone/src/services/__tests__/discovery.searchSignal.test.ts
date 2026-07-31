/**
 * Tests for the search-signal behaviour of getDiscoveryPlaces.
 *
 * postSearchSignal() is a fire-and-forget call to POST /api/compass/signals/search
 * that records the user's category-browsing intent for Compass personalisation.
 *
 * Rules under test:
 *   1. Selecting a non-"for_you" category tab fires the signal exactly once (page=1, emitSignal=true).
 *   2. Paginating (page > 1) does NOT fire the signal, even when emitSignal=true.
 *   3. The "for_you" category never fires the signal, even when emitSignal=true on page 1.
 *   4. emitSignal=false (the default) never fires the signal for any category or page.
 *
 * NOTE: This file is in KNOWN_BROKEN in scripts/run-node-tests.mjs because
 * discovery.ts → supabase.ts → SecureStoreAdapter → react-native triggers an
 * esbuild "Unexpected typeof" error under tsx/esm / Node.js.  The test logic is
 * correct and can be re-enabled once the react-native esbuild incompatibility is
 * resolved for this import chain.
 *
 * Run with:
 *   node --import tsx/esm --test src/services/__tests__/discovery.searchSignal.test.ts
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// Env must be set before the module is imported (lazy via before()).
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';

// ── Lazy imports ──────────────────────────────────────────────────────────────

let getDiscoveryPlaces: (
  destination: string,
  category: import('../discovery.ts').DiscoveryCategory,
  filters: import('../discovery.ts').DiscoveryFilters,
  page?: number,
  contextMode?: null,
  ageFilter?: null,
  customMinAge?: null,
  customMaxAge?: null,
  lat?: null,
  lng?: null,
  userLat?: null,
  userLng?: null,
  emitSignal?: boolean,
) => Promise<unknown>;

let _setTestSupabase: (fake: {
  auth: {
    getSession(): Promise<{ data: { session: { access_token: string; expires_at?: number } | null } }>;
    refreshSession(): Promise<{ data: { session: { access_token: string } | null } }>;
  };
}) => void;

let _resetTestSupabase: () => void;

// ── Fetch mock ────────────────────────────────────────────────────────────────

interface FetchCall { url: string; method: string; }

let fetchCalls: FetchCall[] = [];

const discoveryBody = JSON.stringify({
  places: [],
  total: 0,
  destination: 'Lisbon',
  cached: false,
});

const realFetch = globalThis.fetch;

globalThis.fetch = ((url: string, opts: RequestInit = {}) => {
  fetchCalls.push({ url: String(url), method: String(opts.method ?? 'GET') });
  return Promise.resolve(
    new Response(discoveryBody, { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
}) as typeof fetch;

after(() => { globalThis.fetch = realFetch; });

// ── Flush fire-and-forget promises ────────────────────────────────────────────
// postSearchSignal() is fire-and-forget; a single macrotask tick drains it.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ── Default test filters ──────────────────────────────────────────────────────
const filters = { radiusKm: 10, openNow: false as const, minRating: null };

// ── Fake Supabase token ───────────────────────────────────────────────────────
const fakeSupabase = {
  auth: {
    getSession: async () => ({
      data: {
        session: {
          access_token: 'test-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    }),
    refreshSession: async () => ({ data: { session: { access_token: 'test-token' } } }),
  },
};

// ── Helper: count signal calls ────────────────────────────────────────────────
function signalCalls(): FetchCall[] {
  return fetchCalls.filter((c) => c.url.includes('/api/compass/signals/search'));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getDiscoveryPlaces — search signal', () => {
  before(async () => {
    const discoveryMod = await import('../discovery.ts');
    getDiscoveryPlaces = discoveryMod.getDiscoveryPlaces as typeof getDiscoveryPlaces;

    const tokenMod = await import('../apiToken.ts');
    _setTestSupabase = tokenMod._setTestSupabase;
    _resetTestSupabase = tokenMod._resetTestSupabase;
  });

  beforeEach(() => {
    fetchCalls = [];
    _setTestSupabase(fakeSupabase);
  });

  after(() => {
    _resetTestSupabase();
  });

  it('fires the signal once when a non-for_you category is selected on page 1', async () => {
    await getDiscoveryPlaces('Lisbon', 'food', filters, 1, null, null, null, null, null, null, null, null, true);
    await flush();

    assert.equal(signalCalls().length, 1, 'expected exactly one signal call');
    const sig = signalCalls()[0];
    assert.ok(sig.url.endsWith('/api/compass/signals/search'), `unexpected URL: ${sig.url}`);
    assert.equal(sig.method, 'POST');
  });

  it('fires the signal for every distinct non-for_you category on page 1', async () => {
    const categories = ['places', 'nightlife', 'activities', 'events', 'beaches', 'transport'] as const;
    for (const cat of categories) {
      fetchCalls = [];
      await getDiscoveryPlaces('Lisbon', cat, filters, 1, null, null, null, null, null, null, null, null, true);
      await flush();
      assert.equal(signalCalls().length, 1, `expected one signal for category '${cat}'`);
    }
  });

  it('does NOT fire the signal for page > 1 (pagination must not double-count)', async () => {
    await getDiscoveryPlaces('Lisbon', 'food', filters, 2, null, null, null, null, null, null, null, null, true);
    await flush();

    assert.equal(signalCalls().length, 0, 'no signal must fire on page 2');
  });

  it('does NOT fire the signal for the "for_you" category even on page 1 with emitSignal=true', async () => {
    await getDiscoveryPlaces('Lisbon', 'for_you', filters, 1, null, null, null, null, null, null, null, null, true);
    await flush();

    assert.equal(signalCalls().length, 0, 'for_you must never emit a search signal');
  });

  it('does NOT fire the signal when emitSignal is false (the default)', async () => {
    // Default: emitSignal omitted → false
    await getDiscoveryPlaces('Lisbon', 'food', filters, 1);
    await flush();

    assert.equal(signalCalls().length, 0, 'no signal when emitSignal=false');
  });

  it('fires the signal only once — page 1 signals, page 2 does not (sequential load)', async () => {
    await getDiscoveryPlaces('Lisbon', 'activities', filters, 1, null, null, null, null, null, null, null, null, true);
    await flush();
    const afterPage1 = signalCalls().length;

    await getDiscoveryPlaces('Lisbon', 'activities', filters, 2, null, null, null, null, null, null, null, null, true);
    await flush();
    const afterPage2 = signalCalls().length;

    assert.equal(afterPage1, 1, 'page 1 should emit exactly one signal');
    assert.equal(afterPage2, 1, 'page 2 must not add another signal');
  });
});
