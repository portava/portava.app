/**
 * The Discovery client recognises a REFUSAL.
 *
 * OWNER RULING, 2026-09-14, verbatim and binding — the last sentence is the
 * acceptance bar for this whole file:
 *
 *   "Add upstream_unavailable for upstream dependency failures. Do not cache
 *    rate limits or outages as 'this location does not exist.' Verify that
 *    clients recognize refusal responses, preserve existing bookmarks on read
 *    failures, and exclude failed responses from exposure accounting. A
 *    DISTINGUISHABLE RESPONSE BODY ALONE IS INSUFFICIENT IF CONSUMERS STILL
 *    TREAT IT AS SUCCESSFUL EMPTY DATA."
 *
 * The server side of D11 put `refusal: { class, code, route, coverage }` into
 * every Discovery envelope. Every function in services/discovery.ts then threw
 * it away: `getDiscoveryPlaces` cast the body to `DiscoveryResult` (a type with
 * no `refusal` member), `getDiscoveryCategoryCountsBatch` read `body.counts ??
 * {}`, `getSavedPlaceIds` read `data.ids`, and each returned the same value it
 * returns for a genuinely empty city. The body was distinguishable and no
 * consumer distinguished it. That is the sentence above, exactly.
 *
 * Named *.component.test.tsx so it runs under jest: the node:test runner cannot
 * import discovery.ts → supabase.ts → react-native (see KNOWN_BROKEN in
 * scripts/run-node-tests.mjs, which is why the sibling
 * discovery.searchSignal.test.ts never runs). It renders nothing; it exercises
 * the service directly.
 *
 * Run with: pnpm test:component
 */

// NOTE: intentionally exhaustive — discovery.ts imports the Supabase client for
// its module side effect only (these functions never touch it); the real module
// pulls react-native native internals that crash under jest-expo.
jest.mock('../../lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: false }));

const mockFreshToken = jest.fn(async (): Promise<string | null> => null);
// NOTE: intentionally exhaustive — apiToken.ts reads the Supabase session via
// native storage; the token value is all these tests need and it is controlled
// per test.
jest.mock('../apiToken', () => ({ freshToken: () => mockFreshToken() }));

import {
  getDiscoveryPlaces,
  getDiscoveryCategoryCountsBatch,
  getDiscoveryCategoryCounts,
  getDiscoveryFeed,
  getSavedPlaceIds,
  getCachedDiscoveryPlaces,
  getCommunityPlaces,
  searchUnified,
  getSearchSuggestions,
  _resetDiscoveryClientCache,
} from '../discovery.ts';

const API_BASE = 'http://api.test';

let calls: string[];
let nextResponse: { status: number; body: unknown };

const realFetch = global.fetch;

/** The body GET /discovery sends when Nominatim is rate-limited. */
const UPSTREAM_REFUSAL = {
  class: 'upstream_unavailable',
  code: 'nominatim_http_429',
  route: 'GET /discovery',
  coverage: 'nothing',
};

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = API_BASE; });
afterAll(() => { global.fetch = realFetch; });

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  _resetDiscoveryClientCache();
  mockFreshToken.mockReset();
  mockFreshToken.mockResolvedValue('tok-123');
  global.fetch = jest.fn((url: string | URL | Request) => {
    calls.push(String(url));
    return Promise.resolve(
      new Response(JSON.stringify(nextResponse.body), {
        status: nextResponse.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
});

// ── getDiscoveryPlaces ───────────────────────────────────────────────────────

describe('getDiscoveryPlaces', () => {
  const FILTERS = { radiusKm: 25, openNow: false, minRating: null };

  it('surfaces the refusal instead of returning a bare empty list', async () => {
    nextResponse = {
      status: 200,
      body: { places: [], total: 0, destination: 'Miami', cached: false, refusal: UPSTREAM_REFUSAL },
    };
    const res = await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    expect(res.ok).toBe(true); // the transport succeeded; the ANSWER is the refusal
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refusal).toEqual(UPSTREAM_REFUSAL);
  });

  it('leaves `refusal` absent on a genuinely empty city — the control', async () => {
    // Without this, a client could satisfy the assertion above by stamping a
    // refusal on every empty answer, which distinguishes nothing.
    nextResponse = {
      status: 200,
      body: { places: [], total: 0, destination: 'Nowheresville', cached: false },
    };
    const res = await getDiscoveryPlaces('Nowheresville', 'for_you', FILTERS);
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refusal).toBeUndefined();
  });

  it('DOES NOT CACHE a refused body — the server-side defect, re-committed on the phone', async () => {
    // services/discovery.ts keeps a 4-minute in-memory SWR cache and used to
    // write EVERY 200 into it. Caching a refusal there is the same mistake the
    // geocoder made server-side, one tier down: the outage would be replayed
    // from the device's own memory for four minutes after it ended, and
    // `getCachedDiscoveryPlaces` would paint it as content on the next mount.
    nextResponse = {
      status: 200,
      body: { places: [], total: 0, destination: 'Miami', cached: false, refusal: UPSTREAM_REFUSAL },
    };
    await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    expect(getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1)).toBeNull();
  });

  it('still caches a REAL result — the positive control for the assertion above', async () => {
    // "Nothing was cached" is a weak claim on its own: it also holds if the
    // cache is broken, if the key is wrong, or if nothing ever writes to it.
    nextResponse = {
      status: 200,
      body: {
        places: [{ id: 'node/1', name: 'Real place' }],
        total: 1, destination: 'Miami', cached: false,
      },
    };
    await getDiscoveryPlaces('Miami', 'for_you', FILTERS);
    const cached = getCachedDiscoveryPlaces('Miami', 'for_you', 25, 1);
    expect(cached).not.toBeNull();
    expect(cached?.places).toHaveLength(1);
  });
});

// ── getDiscoveryCategoryCountsBatch ──────────────────────────────────────────

describe('getDiscoveryCategoryCountsBatch', () => {
  it('reports a refused count set instead of returning {} as if the city had none', async () => {
    nextResponse = {
      status: 200,
      body: { counts: {}, destination: 'Miami', cached: false,
        refusal: { ...UPSTREAM_REFUSAL, route: 'GET /discovery/counts' } },
    };
    const res = await getDiscoveryCategoryCountsBatch('Miami');
    expect(res.refusal?.class).toBe('upstream_unavailable');
    expect(res.counts).toEqual({});
  });

  it('carries the partial refusal through, keeping the counts that ARE real', async () => {
    // coverage "partial" is not a failure to discard: the numbers present were
    // genuinely produced. Dropping them would under-report just as dishonestly
    // as reporting the absent ones as zero.
    nextResponse = {
      status: 200,
      body: {
        counts: { food: 12 }, destination: 'Miami', cached: true,
        refusal: { class: 'transient_db', code: 'category_counts_partial',
          route: 'GET /discovery/counts', coverage: 'partial', failedSources: ['beaches'] },
      },
    };
    const res = await getDiscoveryCategoryCountsBatch('Miami');
    expect(res.counts.food).toBe(12);
    expect(res.refusal?.coverage).toBe('partial');
    expect(res.refusal?.failedSources).toEqual(['beaches']);
  });

  it('a genuinely empty count set carries no refusal — the control', async () => {
    nextResponse = { status: 200, body: { counts: {}, destination: 'Nowheresville', cached: true } };
    const res = await getDiscoveryCategoryCountsBatch('Nowheresville');
    expect(res.refusal).toBeUndefined();
  });
});

// ── getDiscoveryCategoryCounts — the PER-CATEGORY fallback ───────────────────
//
// The batch endpoint above is the default. This is the fallback used when
// age-filter or other per-request personalisation is needed, and it fans out to
// GET /discovery once per category. Its own docstring promises "Individual
// failures are silently dropped; only successful responses contribute to the
// returned map" — but it tested `result.value.ok`, and a REFUSAL is `ok: true`.
// A refused category therefore contributed its body's `total`, which is 0. The
// badge row then read "0" for a category the server never counted: not a
// dropped failure but a FABRICATED NUMBER, which is what the batch sibling's own
// type comment already warns about in this same file.

describe('getDiscoveryCategoryCounts (per-category fallback)', () => {
  const COUNT_REFUSAL = {
    class: 'upstream_unavailable', code: 'nominatim_http_429',
    route: 'GET /discovery', coverage: 'nothing',
  };

  /** Serve a different body per `category` param — this function fans out. */
  function serveByCategory(map: Record<string, unknown>) {
    global.fetch = jest.fn((url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      const cat = new URL(u).searchParams.get('category') ?? '';
      return Promise.resolve(
        new Response(JSON.stringify(map[cat] ?? { places: [], total: 0, destination: 'X', cached: false }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
  }

  it('OMITS a refused category rather than reporting it as a real zero', async () => {
    serveByCategory({
      food: { places: [], total: 0, destination: 'Miami', cached: false, refusal: COUNT_REFUSAL },
      places: { places: [{ id: 'node/1' }], total: 42, destination: 'Miami', cached: false },
    });
    const counts = await getDiscoveryCategoryCounts('Miami');

    // `food` was not counted. An absent key is the only honest answer this
    // return type can carry; a 0 states, on the server's behalf, that Miami has
    // no food.
    expect(counts.food).toBeUndefined();
    expect('food' in counts).toBe(false);
    // And the categories that DID answer are unaffected.
    expect(counts.places).toBe(42);
  });

  it('CONTROL: a genuinely empty category IS reported as 0', async () => {
    // Without this, "omit the refused one" is satisfied by omitting everything,
    // which distinguishes nothing and loses every real zero.
    serveByCategory({
      beaches: { places: [], total: 0, destination: 'Reykjavik', cached: false },
    });
    const counts = await getDiscoveryCategoryCounts('Reykjavik');
    expect(counts.beaches).toBe(0);
    expect('beaches' in counts).toBe(true);
  });

  it('CONTROL: a PARTIAL refusal carries a real count, so it IS reported', async () => {
    // `coverage: "partial"` means some sources answered; the total it carries is
    // a real number about real rows. Dropping it would discard a true count.
    serveByCategory({
      nightlife: {
        places: [{ id: 'node/9' }], total: 7, destination: 'Miami', cached: false,
        refusal: { ...COUNT_REFUSAL, coverage: 'partial' },
      },
    });
    const counts = await getDiscoveryCategoryCounts('Miami');
    expect(counts.nightlife).toBe(7);
  });

  it('CONTROL: every category answering gives the full set — the positive control', async () => {
    serveByCategory({});  // all seven answer with a real, genuinely-empty body
    const counts = await getDiscoveryCategoryCounts('Miami');
    expect(Object.keys(counts).sort()).toEqual(
      ['activities', 'beaches', 'events', 'food', 'nightlife', 'places', 'transport'],
    );
  });
});

// ── getDiscoveryFeed — CLIENT-SIDE EXPOSURE ACCOUNTING ───────────────────────

describe('getDiscoveryFeed', () => {
  const FEED_REFUSAL = {
    class: 'upstream_unavailable', code: 'nominatim_http_429',
    route: 'GET /discovery/feed', coverage: 'nothing',
  };

  it('surfaces the refusal', async () => {
    nextResponse = {
      status: 200,
      body: { places: [], posts: [], nextCursor: null, total: 0, destination: 'Miami',
        sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: 0 },
        sessionId: 'sess-refused', refusal: FEED_REFUSAL },
    };
    const res = await getDiscoveryFeed({ destination: 'Miami' });
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refusal).toEqual(FEED_REFUSAL);
  });

  it('DROPS the sessionId on a coverage:"nothing" refusal — nothing was served, so there is nothing to attribute an outcome to', async () => {
    // The exposure half of the ruling, on the client. `sessionId` is the served
    // rank context: the client threads it back on POST /rank-events/outcome so
    // the outcome upgrades THE IMPRESSION THIS LOAD WROTE. A refused load wrote
    // no impression — `logServeUnlessRefused` suppressed it server-side — so a
    // sessionId kept from that response points at nothing. Reporting against it
    // is an outcome with no impression: the numerator of the exposure funnel
    // moving while the denominator did not.
    nextResponse = {
      status: 200,
      body: { places: [], posts: [], nextCursor: null, total: 0, destination: 'Miami',
        sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: 0 },
        sessionId: 'sess-refused', refusal: FEED_REFUSAL },
    };
    const res = await getDiscoveryFeed({ destination: 'Miami' });
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.sessionId).toBeNull();
  });

  it('KEEPS the sessionId on a real serve — the positive control', async () => {
    // Without this, `sessionId === null` above would also pass if the client had
    // simply stopped reading sessionId at all, which would silently break
    // outcome attribution for every healthy load.
    nextResponse = {
      status: 200,
      body: { places: [], posts: [{ id: 'p1' }], nextCursor: null, total: 1, destination: 'Miami',
        sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: 1 },
        sessionId: 'sess-real' },
    };
    const res = await getDiscoveryFeed({ destination: 'Miami' });
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.sessionId).toBe('sess-real');
  });

  it('KEEPS the sessionId on a PARTIAL refusal — those items really were served', async () => {
    // Suppressing a partial would under-count exposure: the same corruption in
    // the other direction, which lib/discoveryRefusal.ts spells out server-side.
    nextResponse = {
      status: 200,
      body: { places: [], posts: [{ id: 'p1' }], nextCursor: null, total: 1, destination: 'Miami',
        sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: 1 },
        sessionId: 'sess-partial',
        refusal: { class: 'transient_db', code: 'feed_places_read_failed',
          route: 'GET /discovery/feed', coverage: 'partial', failedSources: ['food'] } },
    };
    const res = await getDiscoveryFeed({ destination: 'Miami' });
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.sessionId).toBe('sess-partial');
    expect(res.data.refusal?.coverage).toBe('partial');
  });
});

// ── getSavedPlaceIds — THE BOOKMARK READ ─────────────────────────────────────

describe('getSavedPlaceIds', () => {
  const SAVED_REFUSAL = {
    class: 'transient_db', code: 'saved_ids_read_failed',
    route: 'GET /discovery/community/saved-ids', coverage: 'nothing',
  };

  it('reports a refusal instead of an empty id list', async () => {
    // `[]` here means "you have saved nothing", and the consumer renders every
    // bookmark hollow on the strength of it. The server already says the read
    // failed; the client just has to stop discarding the sentence.
    nextResponse = { status: 200, body: { ids: [], refusal: SAVED_REFUSAL } };
    const res = await getSavedPlaceIds();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.refusal).toEqual(SAVED_REFUSAL);
  });

  it('a transport failure is also not-ok, not an empty list', async () => {
    nextResponse = { status: 500, body: { error: 'boom' } };
    const res = await getSavedPlaceIds();
    expect(res.ok).toBe(false);
  });

  it('a user who has genuinely saved nothing gets ok with an empty list — the control', async () => {
    nextResponse = { status: 200, body: { ids: [] } };
    const res = await getSavedPlaceIds();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.ids).toEqual([]);
  });

  it('a real save set comes back intact — the positive control', async () => {
    nextResponse = { status: 200, body: { ids: ['gem-1', 'gem-2'] } };
    const res = await getSavedPlaceIds();
    if (!res.ok) throw new Error('unreachable');
    expect(res.ids).toEqual(['gem-1', 'gem-2']);
  });
});

// ── The remaining Discovery collection routes ────────────────────────────────
//
// The ruling says CLIENTS must recognise refusals — not "the three busiest
// callers". These are the other three collection endpoints the server already
// refuses on (community = serve point 10, search = 8, suggest = 9). Each one
// answered the failure with the same value it answers an empty result with,
// and each is asserted against a control that keeps the genuine empty free of
// a refusal it did not earn.

describe('the remaining Discovery collection routes', () => {
  it('getCommunityPlaces surfaces a refused community read', async () => {
    const refusal = {
      class: 'transient_db', code: 'community_places_read_failed',
      route: 'GET /discovery/community', coverage: 'nothing',
    };
    nextResponse = { status: 200, body: { items: [], city: 'Cebu', total: 0, refusal } };
    const res = await getCommunityPlaces('Cebu');
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refusal).toEqual(refusal);
  });

  it('getCommunityPlaces leaves a city with no gems unmarked — the control', async () => {
    nextResponse = { status: 200, body: { items: [], city: 'Nowheresville', total: 0 } };
    const res = await getCommunityPlaces('Nowheresville');
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refusal).toBeUndefined();
  });

  it('searchUnified surfaces a refused search', async () => {
    const refusal = {
      class: 'transient_db', code: 'visibility_state_unreadable',
      route: 'GET /discovery/search', coverage: 'nothing',
    };
    nextResponse = {
      status: 200,
      body: { results: [], nextCursor: null, hasMore: false, query: 'kopitiam',
        type: 'places', timeLabel: null, refusal },
    };
    const res = await searchUnified('kopitiam', 'places');
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refusal).toEqual(refusal);
  });

  it('searchUnified STILL reports browsing intent when the search was refused', async () => {
    // Guards against the tempting over-correction. postSearchSignal records
    // that the USER SEARCHED — query and city, never results — and the user
    // really did search, whatever the server then failed to do. Suppressing it
    // on a refusal would discard a real intent signal exactly during an outage.
    // The ruling's "exclude failed responses from exposure accounting" is about
    // the impression denominator (rank_events →
    // content_distribution_stats.eligible_impressions), which this endpoint does
    // not touch; and a genuinely empty search signals too, so "produced nothing"
    // was never the criterion.
    nextResponse = {
      status: 200,
      body: { results: [], nextCursor: null, hasMore: false, query: 'kopitiam',
        type: 'places', timeLabel: null,
        refusal: { class: 'transient_db', code: 'search_failed',
          route: 'GET /discovery/search', coverage: 'nothing' } },
    };
    const res = await searchUnified('kopitiam', 'places', undefined, { city: 'Cebu' });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((u) => u.includes('/compass/signals/search')).length).toBeGreaterThan(0);
    // ...and the refusal is still surfaced, which is the part that DOES change.
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refusal?.code).toBe('search_failed');
  });

  it('POSITIVE CONTROL: a real search reports browsing intent on the same path', async () => {
    nextResponse = {
      status: 200,
      body: { results: [], nextCursor: null, hasMore: false, query: 'kopitiam',
        type: 'places', timeLabel: null },
    };
    await searchUnified('kopitiam', 'places', undefined, { city: 'Cebu' });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((u) => u.includes('/compass/signals/search')).length).toBeGreaterThan(0);
  });

  it('getSearchSuggestions tells a too-short query apart from an unreadable one', async () => {
    // /discovery/suggest is the route with three different empty answers. Both
    // arrive as `groups: []`; only the refusal separates them.
    nextResponse = {
      status: 200,
      body: { groups: [], refusal: { class: 'validation', code: 'query_too_short',
        route: 'GET /discovery/suggest', coverage: 'nothing' } },
    };
    const short = await getSearchSuggestions('k');
    if (!short.ok) throw new Error('unreachable');
    expect(short.refusal?.class).toBe('validation');

    nextResponse = {
      status: 200,
      body: { groups: [], refusal: { class: 'transient_db', code: 'visibility_state_unreadable',
        route: 'GET /discovery/suggest', coverage: 'nothing' } },
    };
    const failed = await getSearchSuggestions('kopitiam');
    if (!failed.ok) throw new Error('unreachable');
    expect(failed.refusal?.class).toBe('transient_db');

    nextResponse = { status: 200, body: { groups: [] } };
    const empty = await getSearchSuggestions('kopitiam');
    if (!empty.ok) throw new Error('unreachable');
    expect(empty.refusal).toBeUndefined();
  });
});

// ── A MALFORMED refusal must not be mistaken for a refusal ───────────────────
//
// Parsing has to REPLACE the wire field, not sit beside it. If the raw body is
// spread and the parsed refusal added on top, a garbage `refusal` survives —
// and a consumer that branches on `data.refusal` hides real results behind a
// failure notice on the strength of a string. This is the failure mode of a
// tolerant parser that is only half-applied.

describe('a malformed refusal is dropped, not passed through', () => {
  it('getDiscoveryPlaces drops a non-object refusal', async () => {
    nextResponse = {
      status: 200,
      body: { places: [], total: 0, destination: 'Miami', cached: false, refusal: 'oops' },
    };
    const res = await getDiscoveryPlaces('Miami', 'for_you', { radiusKm: 25, openNow: false, minRating: null });
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refusal).toBeUndefined();
  });

  it('getDiscoveryPlaces drops a refusal object with no class', async () => {
    nextResponse = {
      status: 200,
      body: { places: [], total: 0, destination: 'Miami', cached: false,
        refusal: { code: 'nominatim_http_429', coverage: 'nothing' } },
    };
    const res = await getDiscoveryPlaces('Miami', 'for_you', { radiusKm: 25, openNow: false, minRating: null });
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refusal).toBeUndefined();
  });

  it('getCommunityPlaces drops a non-object refusal', async () => {
    nextResponse = { status: 200, body: { items: [], city: 'Cebu', total: 0, refusal: 42 } };
    const res = await getCommunityPlaces('Cebu');
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refusal).toBeUndefined();
  });

  it('searchUnified drops a non-object refusal', async () => {
    nextResponse = {
      status: 200,
      body: { results: [], nextCursor: null, hasMore: false, query: 'k', type: 'places',
        timeLabel: null, refusal: null },
    };
    const res = await searchUnified('k', 'places');
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refusal).toBeUndefined();
  });

  it('POSITIVE CONTROL: a WELL-FORMED refusal still comes through on the same path', async () => {
    nextResponse = {
      status: 200,
      body: { items: [], city: 'Cebu', total: 0,
        refusal: { class: 'transient_db', code: 'community_places_read_failed',
          route: 'GET /discovery/community', coverage: 'nothing' } },
    };
    const res = await getCommunityPlaces('Cebu');
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refusal?.code).toBe('community_places_read_failed');
  });
});
