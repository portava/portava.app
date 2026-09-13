/**
 * Cache B (the per-user Compass ranked-page cache) must not outlive the
 * authorization it was ranked under.
 *
 * THE DEFECT THIS COVERS
 * =====================
 * `GET /discovery` has two caches with very different shapes:
 *
 *   Cache A — user-INDEPENDENT, stores the raw candidate set, and every serve
 *             from it re-reads the curated rows through
 *             loadCuratedAndCanonicalPlaces(..., viewerBlockedIds). So a block
 *             reaches a cache-A serve on the very next request.
 *
 *   Cache B — per-USER, stores a FINAL RANKED PAGE for 10 minutes, and on a hit
 *             runs only applyFilters over it. applyFilters filters on open-now,
 *             rating, adult-venue and sort — it applies NO block rule, and it
 *             re-reads nothing.
 *
 * The consequence, before the fix: eligibility for a cache-B page was decided
 * once, at write time, and then replayed for up to ten minutes. A user who
 * blocked someone kept receiving that person's submitted places until the TTL
 * expired. The asymmetry with cache A is what makes this a defect rather than a
 * design choice — the same request one branch earlier re-applies blocks.
 *
 * Requirements:
 *   DISCOVERY 01 §7 / 06 §4-§5 — a ranking cache is keyed by user + context, and
 *     final ranking must not be served from a cache that skipped it.
 *   DSV2-05 — "Shared candidate caching must not bypass per-user ranking or
 *     eligibility ... cache-hit paths are tested."
 *   DSV2-06 — "Changes in permission, trip context or evidence validity
 *     invalidate/revalidate affected results."
 *   START_HERE — "Revocation must propagate to caches, projections, queued
 *     attention, and consumers."
 *
 * HOW THE ELIGIBILITY CHANGE IS SIMULATED
 * =======================================
 * `_setTestDbPlacesOverride` short-circuits queryDbPlaces BEFORE its block
 * filter, so the override stands in for "the read that applies blocks": it
 * returns the rows a viewer with THIS block set is allowed to see. The assertion
 * is therefore precisely the one that matters — did the request go back to that
 * read, or did it replay a page ranked under a different block set?
 *
 * Blocks themselves are varied through the fake client's `blocks` table, so
 * fetchBlockedSet (the real one) produces the real Set the route fingerprints.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/discoveryCacheBEligibility.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter, {
  _setTestDbPlacesOverride,
  _clearTestCompassCache,
  _testCompassCacheEntry,
  _testCompassCandidateCacheKey,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import { blockFingerprint } from "../lib/discoveryCacheEligibility.js";
import { classifyFreshness } from "../lib/discoveryCandidate.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";

// ── Block external network calls ──────────────────────────────────────────────
const _originalFetch = globalThis.fetch;
globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (urlStr.includes("overpass-api.de") || urlStr.includes("nominatim.openstreetmap.org")) {
    throw new Error("Network blocked in test environment");
  }
  return _originalFetch(url as string, init);
};

const VIEWER  = "aaaa1111-0000-0000-0000-00000000000a";
const VIEWER2 = "bbbb2222-0000-0000-0000-00000000000b";
const AUTHOR2 = "cccc3333-0000-0000-0000-00000000000c";
const AUTHOR3 = "dddd4444-0000-0000-0000-00000000000d";
const TOKEN   = "cache-b-tok";
const TOKEN2  = "cache-b-tok-2";
const DEST    = "Miami";
const RADIUS  = 10;

function place(id: string, savedCount: number): DiscoveryPlace {
  return {
    id: `db/${id}`, name: id, category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1.0, lat: 25.77, lng: -80.19, tags: [],
    address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount,
  } as DiscoveryPlace;
}

/** What the block-applying read returns for each block state. */
const ALL_ROWS      = () => [place("p1", 10), place("p2", 500), place("p3", 100)];
const WITHOUT_P2    = () => [place("p1", 10), place("p3", 100)];

/**
 * Fake service client. `blocks` is mutable so a test can change the viewer's
 * block set between requests, exactly as a real block would.
 */
function fakeClient(state: { blocks: Array<{ blocker_id: string; blocked_id: string }>; blocksError: boolean }) {
  function benign(): any {
    const q: any = {
      select: () => q, eq: () => q, in: () => q, is: () => q, or: () => q,
      gte: () => q, lte: () => q, gt: () => q, lt: () => q, order: () => q,
      limit: () => q, range: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      insert: () => q, upsert: () => q, update: () => q, delete: () => q,
      then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
    };
    return q;
  }
  return {
    auth: {
      getUser: async (t: string) => {
        if (t === TOKEN)  return { data: { user: { id: VIEWER } },  error: null };
        if (t === TOKEN2) return { data: { user: { id: VIEWER2 } }, error: null };
        return { data: { user: null }, error: null };
      },
    },
    from(table: string) {
      if (table === "blocks") {
        // Two readers hit this table with different shapes: fetchBlockedSet uses
        // .or(blocker_id.eq|blocked_id.eq), and CompassProfileService.buildProfile
        // uses two .eq() reads. Both must answer from the same mutable state, or
        // the branch under test dies in the silent catch at discovery.ts:2039.
        const filters: Array<[string, string]> = [];
        const q: any = {
          select: () => q,
          or: () => q,
          eq: (col: string, val: string) => { filters.push([col, val]); return q; },
          then: (r: any) => {
            if (state.blocksError) {
              return Promise.resolve({ data: null, error: { message: "blocks unreadable" } }).then(r);
            }
            const rows = filters.length === 0
              ? state.blocks
              : state.blocks.filter((b) => filters.every(([c, v]) => (b as any)[c] === v));
            return Promise.resolve({ data: rows, error: null }).then(r);
          },
        };
        return q;
      }
      if (table === "feature_flags") {
        let flag = "";
        // The Compass flag layer reads the whole COMPASS_% family with .like()
        // and caches it; the discovery route then asks isEnabled() for one name.
        // Both shapes have to answer or the branch under test never runs.
        const COMPASS_ROWS = [{ flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true }];
        const q: any = {
          select: () => q,
          eq: (col: string, val: any) => { if (col === "flag") flag = val; return q; },
          like: () => ({
            then: (r: any) => Promise.resolve({ data: COMPASS_ROWS, error: null }).then(r),
          }),
          maybeSingle: async () => {
            if (flag === "COMPASS_V1_RULE_BASED_ENABLED") return { data: { enabled: true }, error: null };
            if (flag === "DISCOVERY_ENGINE_MODE") {
              return { data: { enabled: false, metadata: { mode: "legacy" } }, error: null };
            }
            return { data: null, error: null };
          },
          then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
        };
        return q;
      }
      return benign();
    },
    rpc: async () => ({ data: null, error: null }),
  } as any;
}

function makeApp() {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use(discoveryRouter);
  return app;
}

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(makeApp());
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as any).port}` });
    });
  });
}

async function getDiscovery(url: string, token: string) {
  const res = await fetch(
    `${url}/discovery?destination=${DEST}&category=for_you&lat=25.77&lng=-80.19&radiusKm=${RADIUS}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as {
    cached: boolean;
    places: Array<{ id: string; candidate?: { freshness?: { ageMs: number | null; servedFrom: string } } }>;
  };
  // `cached` is the route's own signal: the cache-B HIT path sends true, the
  // fresh Compass rank sends false. Cache A never populates in this test
  // (Overpass is blocked, so enrichedOsm is empty and nothing is written to it),
  // so `cached: true` here means exactly "served from cache B".
  return { ids: (body.places ?? []).map((p) => p.id), places: body.places ?? [], cached: body.cached };
}

const cacheKeyFor = (user: string) => _testCompassCandidateCacheKey(user, DEST, RADIUS, null);

describe("cache B — the fingerprint helper", () => {
  it("A. is order-independent: the same set in any order is the same fingerprint", () => {
    const a = blockFingerprint(new Set(["u2", "u1", "u3"]));
    const b = blockFingerprint(new Set(["u1", "u3", "u2"]));
    assert.equal(a, b, "an equal block set must always reuse its own cached page");
  });

  it("B. is not size-only: swapping one blocked id for another changes the fingerprint", () => {
    const a = blockFingerprint(new Set(["u1", "u2"]));
    const b = blockFingerprint(new Set(["u1", "u9"]));
    assert.notEqual(a, b, "a same-size block swap must not reuse the page");
  });

  it("C. treats UNREADABLE as its own value, never equal to a readable set", () => {
    assert.notEqual(
      blockFingerprint(null), blockFingerprint(new Set<string>()),
      "unreadable blocks must never compare equal to 'no blocks' — that is the fail-open direction",
    );
    assert.notEqual(
      blockFingerprint(null), blockFingerprint(new Set(["u1"])),
      "unreadable blocks must never compare equal to a populated set",
    );
    assert.equal(
      blockFingerprint(null), blockFingerprint(null),
      "two fail-closed reads are the same page; an outage must not force a re-rank per request",
    );
  });
});

describe("cache B — eligibility must not outlive the page", () => {
  let server: Server;
  let url: string;
  let state: { blocks: Array<{ blocker_id: string; blocked_id: string }>; blocksError: boolean };

  beforeEach(async () => {
    ({ server, url } = await startServer());
    state = { blocks: [], blocksError: false };
    _setTestServiceClient(fakeClient(state));
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
  });

  afterEach(async () => {
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("D. a fresh rank stores a cache-B entry, stamped with the block set it ran under", async () => {
    _setTestDbPlacesOverride(async () => ALL_ROWS());
    const first = await getDiscovery(url, TOKEN);
    assert.ok(first.ids.includes("db/p2"), "precondition: p2 is visible with no blocks");

    const entry = _testCompassCacheEntry(cacheKeyFor(VIEWER));
    assert.ok(entry, "a cache-B entry must be stored after a fresh Compass rank");
    assert.equal(
      entry!.blockKey, blockFingerprint(new Set<string>()),
      "the stored page must record the block set it was ranked under",
    );
  });

  it("E. an UNCHANGED block set still serves from cache (the fix must not disable cache B)", async () => {
    _setTestDbPlacesOverride(async () => ALL_ROWS());

    const first = await getDiscovery(url, TOKEN);
    assert.equal(first.cached, false, "precondition: the first request is a fresh Compass rank");

    const stored = _testCompassCacheEntry(cacheKeyFor(VIEWER));
    const second = await getDiscovery(url, TOKEN);

    assert.equal(
      second.cached, true,
      "an unchanged block set must HIT cache B — the fix must not disable the cache it is fixing",
    );
    assert.deepEqual(second.ids, first.ids, "a cache-B hit replays the ranked order it stored");
    assert.equal(
      _testCompassCacheEntry(cacheKeyFor(VIEWER))!.at, stored!.at,
      "a hit reuses the stored entry rather than re-ranking and re-storing it",
    );
  });

  it("K. a viewer with a STABLE NON-EMPTY block set still HITS cache B (no over-invalidation)", async () => {
    // Found by mutation M5: stamping a CONSTANT blockKey at the store site left
    // every case above green, because the constant happened to equal the
    // no-blocks fingerprint and every other case then mismatched — i.e. the
    // suite could see under-invalidation but not OVER-invalidation. A viewer
    // who blocks somebody and then changes nothing must still get their cache.
    state.blocks = [{ blocker_id: VIEWER, blocked_id: AUTHOR3 }];
    _setTestDbPlacesOverride(async () => ALL_ROWS());

    const first = await getDiscovery(url, TOKEN);
    assert.equal(first.cached, false, "precondition: first request is a fresh rank");

    const stored = _testCompassCacheEntry(cacheKeyFor(VIEWER));
    assert.equal(
      stored!.blockKey, blockFingerprint(new Set([AUTHOR3])),
      "the stored page must be stamped with the viewer's ACTUAL block set, not a constant",
    );

    const second = await getDiscovery(url, TOKEN);
    assert.equal(
      second.cached, true,
      "an unchanged NON-EMPTY block set must still hit cache B — invalidating every request would be a load bug wearing a correctness costume",
    );
  });

  it("F. the cache key still separates users — one viewer's page never serves another", async () => {
    _setTestDbPlacesOverride(async () => ALL_ROWS());
    await getDiscovery(url, TOKEN);

    assert.ok(_testCompassCacheEntry(cacheKeyFor(VIEWER)), "viewer 1 has an entry");
    assert.equal(
      _testCompassCacheEntry(cacheKeyFor(VIEWER2)), null,
      "viewer 2 must not share viewer 1's cached final order",
    );
  });

  it("G. DEFECT: a block taken INSIDE the TTL must not be served around", async () => {
    // Request 1 — no blocks. p2 is visible and the ranked page is cached.
    _setTestDbPlacesOverride(async () => ALL_ROWS());
    const before = await getDiscovery(url, TOKEN);
    assert.ok(before.ids.includes("db/p2"), "precondition: p2 visible before the block");

    // The viewer blocks p2's author. The block-applying read now withholds p2.
    state.blocks = [{ blocker_id: VIEWER, blocked_id: AUTHOR2 }];
    _setTestDbPlacesOverride(async () => WITHOUT_P2());

    const after = await getDiscovery(url, TOKEN);
    assert.equal(
      after.cached, false,
      "a changed block set must MISS cache B and re-rank — a hit here is the defect",
    );
    assert.ok(
      !after.ids.includes("db/p2"),
      `a blocked author's place must disappear on the NEXT request, not after the 10-minute TTL — got ${JSON.stringify(after.ids)}`,
    );
    assert.ok(after.ids.includes("db/p1"), "the rest of the page must survive the invalidation");
  });

  it("H. DEFECT: swapping one blocked id for another (same size) must also invalidate", async () => {
    state.blocks = [{ blocker_id: VIEWER, blocked_id: AUTHOR3 }];
    _setTestDbPlacesOverride(async () => ALL_ROWS());
    const before = await getDiscovery(url, TOKEN);
    assert.ok(before.ids.includes("db/p2"), "precondition: p2 visible while only AUTHOR3 is blocked");

    // Same-size block set, different member.
    state.blocks = [{ blocker_id: VIEWER, blocked_id: AUTHOR2 }];
    _setTestDbPlacesOverride(async () => WITHOUT_P2());

    const after = await getDiscovery(url, TOKEN);
    assert.equal(after.cached, false, "a same-size block swap must MISS cache B");
    assert.ok(
      !after.ids.includes("db/p2"),
      `a same-size block swap must invalidate — a size-only key would reuse the page; got ${JSON.stringify(after.ids)}`,
    );
  });

  it("I. DEFECT: an UNREADABLE block set must not reuse a page ranked when blocks were readable", async () => {
    _setTestDbPlacesOverride(async () => ALL_ROWS());
    await getDiscovery(url, TOKEN);
    const readable = _testCompassCacheEntry(cacheKeyFor(VIEWER));
    assert.ok(readable, "precondition: a readable-state page is cached");

    // The blocks table stops answering. Every Discovery reader treats that as
    // fail-closed; the cached page was built under a verified block set and is
    // no longer safe to replay.
    state.blocksError = true;
    _setTestDbPlacesOverride(async () => WITHOUT_P2());

    const after = await getDiscovery(url, TOKEN);
    assert.equal(
      after.cached, false,
      "an unreadable block set must MISS a page ranked under a readable one — replaying it would serve rows the current request cannot verify",
    );
    assert.ok(
      !after.ids.includes("db/p2"),
      `the fail-closed read's result must be what is served, not the cached page; got ${JSON.stringify(after.ids)}`,
    );
  });
});

describe("cache B — 06 §5 cache metadata", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestServiceClient(fakeClient({ blocks: [], blocksError: false }));
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
  });

  afterEach(async () => {
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("J. DEFECT: the ranking timestamp survives cache reuse (06 §5 'ranking timestamp')", async () => {
    _setTestDbPlacesOverride(async () => ALL_ROWS());
    await getDiscovery(url, TOKEN);            // fresh rank → stores entry
    const hit = await getDiscovery(url, TOKEN); // cache-B hit

    // The end-to-end leg only has something to observe once
    // `discovery_candidate_projection_enabled` (migration 2361) is applied and
    // lit; it is seeded FALSE, so on this tree the projection returns the same
    // array and there is no `candidate` to inspect. Stated rather than hidden:
    // this half of the assertion is INERT today and becomes live with the flag.
    const withCandidate = hit.places.find((p) => p.candidate?.freshness);
    if (withCandidate) {
      assert.equal(
        withCandidate.candidate!.freshness!.servedFrom, "compass_candidate_hit",
        "precondition: this row came from the cache-B hit path",
      );
      assert.notEqual(
        withCandidate.candidate!.freshness!.ageMs, null,
        "a cache-B hit knows the entry's age — it reads it for the TTL check — so freshness must not report 'unknown'",
      );
    }

    // The leg that is live today: the entry the route hands the projection does
    // carry a usable clock, and the mapping turns it into a real age. This is
    // what makes passing `cachedAt: cCacheHit.at` rather than `null` load-bearing
    // rather than cosmetic.
    const entry = _testCompassCacheEntry(cacheKeyFor(VIEWER));
    assert.ok(entry && Number.isFinite(entry.at), "the stored entry carries its write clock");

    const fromNull = classifyFreshness("compass_candidate_hit", null, Date.now());
    const fromAt   = classifyFreshness("compass_candidate_hit", entry!.at, Date.now());
    assert.equal(fromNull.ageMs, null, "a null cachedAt can only ever report an unknown age");
    assert.notEqual(
      fromAt.ageMs, null,
      "the entry's own clock must produce a real age — discarding it is what the fix stopped doing",
    );
  });
});
