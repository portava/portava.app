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

// ── DV-04 / DSV2-06 — 06 §5 cache metadata, all five fields ───────────────────
//
// THE DEFECT THIS COVERS
// ======================
// `01` §7 "Cache B problem": *"Caching final ranked order without feature
// vectors makes re-ranking, diagnostics, and counterfactual analysis
// impossible."* The allowed pattern ends *"always preserve recommendation
// metadata and feature/version references."*  `06` §5 names the five fields
// exactly: model_version, feature_version, candidate source, recommendation
// reasons, ranking timestamp.
//
// Before the fix, `_compassCandidateCache` stored `{ places, at, blockKey }` —
// the ranked ORDER and a write clock, nothing else — and BOTH Compass serve
// points handed the projection `scoredById: null`, so even the FRESH rank threw
// away the `rankingFactors` the Compass pipeline had just computed. Four of the
// five fields did not exist anywhere in the request, and the fifth (`at`) is a
// cache write clock, not a ranking timestamp.
//
// WHY THE SHARPEST ASSERTION IS EQUALITY ACROSS THE HIT
// ====================================================
// DSV2-06: *"feature and model provenance survives cache reuse."* An
// implementation that re-stamps `rankedAt: Date.now()` on the replay would
// satisfy "the field is present" and still be wrong: it would report the moment
// the cache was READ as the moment the ranker RAN. So the hit is compared to
// the fresh rank field by field, and `rankedAt` in particular must be the
// ORIGINAL ranking time.
//
// The projection is gated by `discovery_candidate_projection_enabled`
// (migration 2361, seeded FALSE). This block's fake client reports that flag
// ENABLED so the projection leg can be exercised at all; no production flag is
// touched and the shipping default is still OFF.
import {
  invalidateCandidateProjectionFlagCache,
  type DiscoveryCandidate,
} from "../lib/discoveryCandidate.js";

function fakeClientProjectionOn(state: { blocks: Array<{ blocker_id: string; blocked_id: string }>; blocksError: boolean }) {
  const base = fakeClient(state);
  return {
    ...base,
    from(table: string) {
      if (table === "feature_flags") {
        let flag = "";
        const COMPASS_ROWS = [{ flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true }];
        const q: any = {
          select: () => q,
          eq: (col: string, val: any) => { if (col === "flag") flag = val; return q; },
          like: () => ({ then: (r: any) => Promise.resolve({ data: COMPASS_ROWS, error: null }).then(r) }),
          maybeSingle: async () => {
            if (flag === "COMPASS_V1_RULE_BASED_ENABLED") return { data: { enabled: true }, error: null };
            if (flag === "discovery_candidate_projection_enabled") return { data: { enabled: true }, error: null };
            if (flag === "DISCOVERY_ENGINE_MODE") {
              return { data: { enabled: false, metadata: { mode: "legacy" } }, error: null };
            }
            return { data: null, error: null };
          },
          then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
        };
        return q;
      }
      return base.from(table);
    },
  } as any;
}

describe("cache B — 06 §5 the five metadata fields survive the cache (DV-04 / DSV2-06)", () => {
  let server: Server;
  let url: string;

  async function serve(token: string) {
    const res = await fetch(
      `${url}/discovery?destination=${DEST}&category=for_you&lat=25.77&lng=-80.19&radiusKm=${RADIUS}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = (await res.json()) as {
      cached: boolean;
      places: Array<{ id: string; candidate?: DiscoveryCandidate }>;
    };
    return { cached: body.cached, places: body.places ?? [] };
  }

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestServiceClient(fakeClientProjectionOn({ blocks: [], blocksError: false }));
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
    invalidateCandidateProjectionFlagCache();
    _setTestDbPlacesOverride(async () => ALL_ROWS());
  });

  afterEach(async () => {
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
    invalidateCandidateProjectionFlagCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("L. the FRESH Compass rank emits all five 06 §5 fields", async () => {
    const fresh = await serve(TOKEN);
    assert.equal(fresh.cached, false, "precondition: first request is a fresh Compass rank");

    const row = fresh.places[0];
    assert.ok(row?.candidate, "precondition: the projection flag is on in this block, so every row carries `candidate`");

    const prov = row.candidate!.provenance;
    assert.ok(prov, "06 §5: a ranked serve must carry recommendation metadata; got none");
    assert.equal(typeof prov!.modelVersion, "string", "06 §5 model_version");
    assert.ok(prov!.modelVersion.length > 0, "06 §5 model_version must not be blank");
    assert.equal(typeof prov!.featureVersion, "string", "06 §5 feature_version");
    assert.ok(prov!.featureVersion.length > 0, "06 §5 feature_version must not be blank");
    assert.equal(
      prov!.candidateSource, "curated_db",
      "06 §5 candidate source: these rows came from loadCuratedAndCanonicalPlaces, not from Overpass",
    );
    assert.ok(Array.isArray(prov!.reasons), "06 §5 recommendation reasons must be a list");
    assert.ok(
      Number.isFinite(prov!.rankedAt),
      "06 §5 ranking timestamp: the moment the RANKER ran, which the cache write clock is not",
    );
  });

  it("M. DEFECT: every one of the five survives the cache-B HIT, and rankedAt is the ORIGINAL ranking time", async () => {
    const fresh = await serve(TOKEN);
    assert.equal(fresh.cached, false, "precondition: fresh rank");
    const freshProv = fresh.places[0]?.candidate?.provenance;
    assert.ok(freshProv, "precondition: the fresh rank carries provenance (see L)");

    const hit = await serve(TOKEN);
    assert.equal(hit.cached, true, "precondition: the second request is a cache-B hit");
    assert.deepEqual(
      hit.places.map((p) => p.id), fresh.places.map((p) => p.id),
      "precondition: the hit replays the stored order",
    );

    const hitProv = hit.places[0]?.candidate?.provenance;
    assert.ok(
      hitProv,
      "DSV2-06: feature and model provenance must survive cache reuse — a replayed page with no metadata is exactly the `01` §7 Cache B defect",
    );
    assert.equal(hitProv!.modelVersion,   freshProv!.modelVersion,   "model_version must survive the cache");
    assert.equal(hitProv!.featureVersion, freshProv!.featureVersion, "feature_version must survive the cache");
    assert.equal(hitProv!.candidateSource, freshProv!.candidateSource, "candidate source must survive the cache");
    assert.deepEqual(hitProv!.reasons,    freshProv!.reasons,        "recommendation reasons must survive the cache");
    assert.equal(
      hitProv!.rankedAt, freshProv!.rankedAt,
      "the ranking timestamp must be when the RANKER ran, not when the cache was read — re-stamping it on replay reports a rank that never happened",
    );
  });

  it("N. DEFECT: the feature vector survives, so a cached page can still be re-ranked and diagnosed", async () => {
    const fresh = await serve(TOKEN);
    const hit   = await serve(TOKEN);
    assert.equal(hit.cached, true, "precondition: cache-B hit");

    // `01` §7: caching final ranked order WITHOUT FEATURE VECTORS is the named
    // defect. The order alone cannot be re-ranked or explained after the fact.
    const freshProv = fresh.places[0]?.candidate?.provenance;
    const hitProv   = hit.places[0]?.candidate?.provenance;
    assert.ok(freshProv, "a ranked serve must carry what it ranked on");
    assert.ok(
      hitProv,
      "01 §7: a cached final order with no feature vector makes re-ranking, diagnostics and counterfactual analysis impossible",
    );
    assert.deepEqual(hitProv!.features, freshProv!.features, "the cached RAW feature bag must be the one the ranker produced");
    assert.deepEqual(hitProv!.scores,   freshProv!.scores,   "the cached DERIVED scores must survive too");
    assert.ok(
      Object.keys(hitProv!.scores).length > 0,
      "an empty score bag is the same absence wearing a field name",
    );
  });

  it("N2. 04 §13: raw and derived are SEPARATED — no derived score leaks into the feature bag", async () => {
    const hitOrFresh = (await serve(TOKEN)).places[0]?.candidate?.provenance;
    assert.ok(hitOrFresh, "precondition: a ranked serve carries provenance");

    for (const k of Object.keys(hitOrFresh!.features)) {
      assert.ok(
        k.startsWith("factor_"),
        `04 §13: \`features\` holds only RAW per-signal contributions; ${k} is a derived score and belongs in \`scores\``,
      );
    }
    for (const k of Object.keys(hitOrFresh!.scores)) {
      assert.ok(
        !k.startsWith("factor_"),
        `04 §13: \`scores\` holds only DERIVED values; ${k} is a raw signal and belongs in \`features\``,
      );
    }
    assert.deepEqual(
      Object.keys(hitOrFresh!.features).filter((k) => k in hitOrFresh!.scores), [],
      "no key may appear in both bags — a value that is both raw and derived is neither",
    );
  });

  it("O. rankedBy says `compass` on both Compass serve points — the projection must not report `none` where a ranker ran", async () => {
    const fresh = await serve(TOKEN);
    const hit   = await serve(TOKEN);
    assert.equal(fresh.places[0]?.candidate?.rankedBy, "compass", "the fresh Compass rank DID run a per-user ranker");
    assert.equal(hit.places[0]?.candidate?.rankedBy,   "compass", "the replayed page was ranked by Compass, and says so");
  });
});

// ── DSV2-06 — "Bound final caches by authorized context, VERSION and freshness" ──
//
// The census recorded DSV2-06 as W with the permission leg closed (§11.8's
// blockKey) and the provenance leg open. The third noun in the requirement is
// the one nothing bound: a page ranked by one model/feature shape stayed usable
// after a deploy that changed that shape, because the entry recorded no version
// and the hit path compared none. `06` §5's allowed pattern is explicit —
// "optionally cache short-lived ranking results keyed by user + context +
// MODEL/VERSION".
//
// The acceptance rule is extracted into lib/discoveryCacheEligibility so the
// precedence between its four rejection reasons can be tested without standing
// up the route; the route test below pins that the route actually consults it.
import {
  rankVersionKey,
  cacheBEntryUsable,
  CACHE_B_TTL_MS,
} from "../lib/discoveryCacheEligibility.js";
import {
  DISCOVERY_MODEL_VERSION,
  DISCOVERY_FEATURE_VERSION,
} from "../lib/discoveryRankProvenance.js";
import { _testPokeCompassCacheRankVersion } from "../routes/discovery.js";

describe("cache B — version binding (DSV2-06)", () => {
  const NOW = 1_800_000_000_000;
  const V = rankVersionKey(DISCOVERY_MODEL_VERSION, DISCOVERY_FEATURE_VERSION);
  const base = { at: NOW - 1_000, blockKey: "none", rankVersion: V };
  const req  = { nowMs: NOW, blockKey: "none", rankVersion: V, ttlMs: CACHE_B_TTL_MS };

  it("P1. an entry matching on every axis is usable", () => {
    assert.deepEqual(cacheBEntryUsable(base, req), { usable: true, reason: "hit" });
  });

  it("P2. a missing entry is 'absent', not a silent false", () => {
    assert.deepEqual(cacheBEntryUsable(null, req), { usable: false, reason: "absent" });
  });

  it("P3. an entry past the TTL is 'expired'", () => {
    assert.deepEqual(
      cacheBEntryUsable({ ...base, at: NOW - CACHE_B_TTL_MS }, req),
      { usable: false, reason: "expired" },
      "an entry exactly at the TTL is expired — the boundary must not be usable, or the TTL is TTL+1ms",
    );
  });

  it("P4. a changed block set is rejected, and named as such", () => {
    assert.deepEqual(
      cacheBEntryUsable({ ...base, blockKey: "1:u9" }, req),
      { usable: false, reason: "block_set_changed" },
    );
  });

  it("P5. DEFECT: a page ranked under a DIFFERENT model/feature version is not this request's to reuse", () => {
    assert.deepEqual(
      cacheBEntryUsable({ ...base, rankVersion: rankVersionKey("older-model", DISCOVERY_FEATURE_VERSION) }, req),
      { usable: false, reason: "rank_version_changed" },
      "06 §5: a ranking cache is keyed by user + context + model/version; replaying across a version boundary serves an order the current ranker never produced",
    );
    assert.deepEqual(
      cacheBEntryUsable({ ...base, rankVersion: rankVersionKey(DISCOVERY_MODEL_VERSION, "older-features") }, req),
      { usable: false, reason: "rank_version_changed" },
      "the FEATURE version must bind too — a same-model page whose feature bag has a different shape cannot be re-ranked against the current one",
    );
  });

  it("P6. an entry with NO recorded version is rejected, never accepted by default", () => {
    assert.deepEqual(
      cacheBEntryUsable({ ...base, rankVersion: null }, req),
      { usable: false, reason: "rank_version_changed" },
      "an unversioned entry pre-dates version binding; treating unknown as matching is the fail-open direction",
    );
  });

  it("P7. eligibility outranks version — a page the viewer may not see is rejected as such", () => {
    assert.deepEqual(
      cacheBEntryUsable({ ...base, blockKey: "1:u9", rankVersion: "stale" }, req),
      { usable: false, reason: "block_set_changed" },
      "when both fail, the reported reason must be the authorization one: it is the one that matters operationally",
    );
  });
});

describe("cache B — the route consults the version binding (DSV2-06)", () => {
  let server: Server;
  let url: string;

  async function serve(token: string) {
    const res = await fetch(
      `${url}/discovery?destination=${DEST}&category=for_you&lat=25.77&lng=-80.19&radiusKm=${RADIUS}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { cached: boolean };
    return body.cached;
  }

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestServiceClient(fakeClient({ blocks: [], blocksError: false }));
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
    _setTestDbPlacesOverride(async () => ALL_ROWS());
  });

  afterEach(async () => {
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("Q1. a stored page records the rank version it was produced under", async () => {
    assert.equal(await serve(TOKEN), false, "precondition: fresh rank");
    const entry = _testCompassCacheEntry(cacheKeyFor(VIEWER));
    assert.equal(
      entry!.rankVersion, rankVersionKey(DISCOVERY_MODEL_VERSION, DISCOVERY_FEATURE_VERSION),
      "the stored page must record the model/feature shape that produced it",
    );
  });

  it("Q2. DEFECT: after a rank-version change the stored page MISSES and re-ranks", async () => {
    assert.equal(await serve(TOKEN), false, "precondition: fresh rank");
    assert.equal(await serve(TOKEN), true, "precondition: an unchanged version hits");

    // Stand in for "this page was ranked before the ranker changed".
    _testPokeCompassCacheRankVersion(cacheKeyFor(VIEWER), "some-older-model|some-older-features");

    assert.equal(
      await serve(TOKEN), false,
      "a page ranked under a different model/feature version must not be replayed — 06 §5 keys a ranking cache by model/version",
    );
    assert.equal(
      _testCompassCacheEntry(cacheKeyFor(VIEWER))!.rankVersion,
      rankVersionKey(DISCOVERY_MODEL_VERSION, DISCOVERY_FEATURE_VERSION),
      "the re-rank must re-stamp the entry with the CURRENT version, or every subsequent request re-ranks forever",
    );
  });
});
