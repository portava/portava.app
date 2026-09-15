/**
 * `04` §10.6 — "test recommendation_id propagation", measured at the ROUTE.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT src/test/discoveryServeLog.test.ts
 * =========================================================================
 * `discoveryServeLog.test.ts` (R1–R3) proves that `logDiscoveryServe` MINTS a
 * recommendation id when it is called. That is a unit proof of the writer. It
 * cannot answer the question `04` §10.6 actually asks, which is a property of
 * the SERVE PATH: does an id reach the stored event for an item a real request
 * actually put in front of a user?
 *
 * The distinction is not academic here. `GET /discovery` has SIX serve points
 * and they do not share a writer:
 *
 *   serve point 1/2/3  cache-A L1 / L2-fresh / L2-stale, no ranker
 *                        → lib/discoveryServeLog.logDiscoveryServe   (mints)
 *   serve point 1/2/3  cache-A, PDE ranked in-request
 *                        → lib/rankLog.logImpression                  (does NOT mint)
 *   serve point 4      Compass candidate-cache hit  → logDiscoveryServe (mints)
 *   serve point 5      Compass fresh rank           → logDiscoveryServe (mints)
 *   serve point 6      cold fetch, legacy rank
 *                        → lib/rankLog.logImpression                  (does NOT mint)
 *   serve point 7      GET /discovery/feed          → logDiscoveryServe (mints)
 *
 * So "every served item must have a `recommendation_id`" (`04` §5) is true on
 * four of the six and false on exactly the two where a RANKER RAN — the two
 * whose exposures a denominator most needs to distinguish. A unit test of the
 * writer is green for all six and cannot see that.
 *
 * WHAT IS PINNED
 * ==============
 *   P1. A real `GET /discovery` cache-A serve writes one `rank_events` row per
 *       served place, each carrying a non-blank `features.recommendationId`,
 *       and no two rows on the page share one.
 *   P2. All nine `04` §5 fields are recoverable from the rows THE ROUTE wrote,
 *       checked against `RECOMMENDATION_RECORD_LOCATION` — the module's own
 *       machine-readable statement of where each field lives — rather than
 *       against this file's memory of the list.
 *   P3. With `discovery_serve_log_enabled` absent the route writes nothing, so
 *       nothing here is a production behaviour change.
 *   G1. THE OPEN HALF, asserted rather than described: the same request in
 *       `pde` mode writes its impressions through `lib/rankLog.logImpression`,
 *       and those rows carry NO `recommendationId`, NO `modelVersion` and NO
 *       `reasonCodes`. This is census-discovery DV-40's remaining gap. It is
 *       asserted as the CURRENT state on purpose: when `lib/rankLog.ts` gains
 *       the mint (the cross-lane request filed with this pass), G1 goes RED and
 *       must be INVERTED into the same assertion as P1. A row that quietly
 *       started carrying an id would otherwise close a census row with nobody
 *       noticing, and one that quietly stopped would open one the same way.
 *   G2. The same asymmetry in the flag: the four minting serve points are gated
 *       on `discovery_serve_log_enabled`; the two ranked ones write regardless.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/discoveryRouteRecommendationPropagation.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter, {
  _setTestDbPlacesOverride,
  _injectTestCacheEntry,
  _clearTestCacheEntry,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import {
  DISCOVERY_SERVE_LOG_FLAG,
  invalidateServeLogFlagCache,
  DiscoveryServePoint,
} from "../lib/discoveryServeLog.js";
import {
  RECOMMENDATION_RECORD_FIELDS,
  RECOMMENDATION_RECORD_LOCATION,
} from "../lib/discoveryRecommendationId.js";

const USER  = "aaaa1111-0000-0000-0000-000000000001";
const TOKEN = "rec-prop-tok";
/** cacheKey(dest.toLowerCase().trim(), category, radiusKm) — routes/discovery.ts:290. */
const KEY   = "miami:for_you:10";

function cand(id: string, savedCount: number): DiscoveryPlace {
  return {
    id: `db/${id}`, name: id, category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1.0, lat: 25.77, lng: -80.19, tags: [],
    address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount,
  } as DiscoveryPlace;
}

/** Four distinct places; p4 dominates on social proof so `pde` visibly re-ranks. */
function freshCandidates(): DiscoveryPlace[] {
  return [cand("p1", 1), cand("p2", 2), cand("p3", 3), cand("p4", 500)];
}

// ── Capturing service client ──────────────────────────────────────────────────
//
// Modelled on src/test/discoveryPdeServePath.test.ts's benign client, with one
// addition: every `.insert` is recorded with its table, so the assertions below
// read the rows the ROUTE produced rather than a writer called directly.

function fakeClient(opts: { mode: "legacy" | "pde"; serveLog: boolean }) {
  const inserts: Array<{ table: string; rows: any[] }> = [];

  function benign(table: string): any {
    const q: any = {
      select: () => q, eq: () => q, in: () => q, is: () => q, or: () => q,
      neq: () => q, not: () => q, ilike: () => q, like: () => q,
      gte: () => q, lte: () => q, gt: () => q, lt: () => q, order: () => q,
      limit: () => q, range: () => q, contains: () => q, overlaps: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      insert: (data: any) => {
        const rows = Array.isArray(data) ? data : [data];
        inserts.push({ table, rows });
        return Promise.resolve({ data: null, error: null });
      },
      upsert: () => Promise.resolve({ data: null, error: null }),
      update: () => q, delete: () => q,
      then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
    };
    return q;
  }

  const client = {
    auth: {
      getUser: async (t: string) =>
        t === TOKEN ? { data: { user: { id: USER } }, error: null }
                    : { data: { user: null }, error: null },
    },
    from(table: string) {
      if (table !== "feature_flags") return benign(table);
      let flag = "";
      const q: any = {
        select: () => q,
        eq: (col: string, val: any) => { if (col === "flag") flag = val; return q; },
        maybeSingle: async () => {
          if (flag === "DISCOVERY_ENGINE_MODE") {
            return {
              data: { enabled: true, metadata: { mode: opts.mode, cohort: { kind: "all" } } },
              error: null,
            };
          }
          if (flag === "disable_discovery_pde") return { data: { enabled: false }, error: null };
          if (flag === DISCOVERY_SERVE_LOG_FLAG) {
            return opts.serveLog
              ? { data: { enabled: true }, error: null }
              : { data: null, error: null };   // absent row ⇒ fail-closed OFF
          }
          return { data: null, error: null };
        },
        then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  } as any;

  return {
    client,
    /**
     * IMPRESSION rows only.
     *
     * `rank_events` has a second Discovery writer that is not a serve:
     * `services/ranking/DiscoveryRankingService.writeRankAnalyticAsync` inserts
     * one `outcome:'analytics'` row per CANDIDATE it scores, with no position
     * and no `features`. Counting those as exposures is precisely the mistake
     * `lib/discoveryPde.ts:462-470` documents on the read side ("a request ranks
     * up to 180 candidates while serving 20"), so this filter is the same
     * invariant applied on the write side. Without it a `pde` serve of four
     * places reports eight rows.
     */
    rankEventRows: () =>
      inserts.filter((i) => i.table === "rank_events")
             .flatMap((i) => i.rows)
             .filter((r: any) => r.outcome === "impression"),
    analyticsRows: () =>
      inserts.filter((i) => i.table === "rank_events")
             .flatMap((i) => i.rows)
             .filter((r: any) => r.outcome === "analytics"),
  };
}

// ── Server harness ────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use(discoveryRouter);
  return app;
}

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(makeApp());
    // `listen(0, "127.0.0.1")` and not `listen(0)` — src/test/loopbackBindGuard.test.ts
    // fails a test server that binds every interface.
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function fetchDiscovery(url: string): Promise<string[]> {
  const res = await fetch(`${url}/discovery?destination=Miami&lat=25.77&lng=-80.19`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as { places: Array<{ id: string }> };
  return (body.places ?? []).map((p) => p.id);
}

/** Every write here is un-awaited and lands AFTER res.json. Poll, do not guess. */
async function waitForRows(f: ReturnType<typeof fakeClient>, atLeast: number): Promise<any[]> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const rows = f.rankEventRows();
    if (rows.length >= atLeast || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Give an un-awaited write a fair chance to happen when we expect NONE. */
const quiesce = () => new Promise((r) => setTimeout(r, 80));

/**
 * Resolve one `04` §5 field to the value the row carries, using the module's
 * own location table. Returns `undefined` when the field is absent, which is
 * what the assertions test — so a location string this resolver does not
 * understand must FAIL rather than silently report "present".
 */
function fieldValue(row: any, field: string): unknown {
  const loc = RECOMMENDATION_RECORD_LOCATION[field as never] as string;
  if (loc === "columns item_kind + item_id") {
    return row.item_kind !== undefined && row.item_id !== undefined
      ? [row.item_kind, row.item_id] : undefined;
  }
  if (loc.startsWith("column ")) return row[loc.slice("column ".length)];
  if (loc.startsWith("features.")) return row.features?.[loc.slice("features.".length)];
  throw new Error(`unrecognised RECOMMENDATION_RECORD_LOCATION entry: ${loc}`);
}

// ── P1 / P2 / P3 — the four minting serve points, through the route ───────────

describe("04 §10.6 — recommendation_id propagates through GET /discovery (serve-log paths)", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestDbPlacesOverride(async () => []);   // candidates come only from the injected cache
    invalidateDiscoveryEngineModeCache();
    invalidateServeLogFlagCache();
  });
  afterEach(async () => {
    _clearTestCacheEntry(KEY);
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    invalidateDiscoveryEngineModeCache();
    invalidateServeLogFlagCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("P1. every item a cache-A serve put in front of the user carries a distinct recommendation_id", async () => {
    const f = fakeClient({ mode: "legacy", serveLog: true });
    _setTestServiceClient(f.client);
    _injectTestCacheEntry(KEY, freshCandidates());

    const served = await fetchDiscovery(url);
    assert.equal(served.length, 4, "precondition: the cache-A hit served four places");

    const rows = await waitForRows(f, served.length);
    assert.equal(
      rows.length, served.length,
      "04 §5: one exposure row per SERVED item — a served item with no row has no id at all",
    );
    assert.deepEqual(
      rows.map((r: any) => r.item_id), served,
      "the rows must describe the page the user received, in served order",
    );

    const ids = rows.map((r: any) => r.features?.recommendationId);
    for (const id of ids) {
      assert.equal(typeof id, "string", "04 §5: every served item must have a recommendation_id");
      assert.ok((id as string).length > 0, "a blank id is an absent id wearing a field name");
    }
    assert.equal(
      new Set(ids).size, ids.length,
      "two items served on one page are two exposures and must not share one id",
    );
    assert.equal(
      rows[0].features?.servePoint, DiscoveryServePoint.CACHE_A_L1,
      "precondition: this was the L1 cache-A serve point, not some other writer",
    );
  });

  it("P1b. the id binds the EXPOSURE, not the item — the SAME place served twice gets two ids", async () => {
    // P1's four-distinct-item fixture cannot tell the two hypotheses apart:
    // "the id identifies the exposure" and "the id identifies the item" both
    // predict four different ids. Pinning `position` to 0 inside the derivation
    // therefore leaves P1 entirely green (verified by mutation M2). The one
    // arrangement that separates them is the same place at two positions, which
    // is TWO exposures and must be TWO ids — otherwise the denominator
    // `04` §5 exists to measure under-counts by exactly the repeats.
    const f = fakeClient({ mode: "legacy", serveLog: true });
    _setTestServiceClient(f.client);
    _injectTestCacheEntry(KEY, [cand("p1", 1), cand("p2", 2), cand("p1", 1)]);

    const served = await fetchDiscovery(url);
    assert.deepEqual(
      served, ["db/p1", "db/p2", "db/p1"],
      "precondition: the serve path really did put the same place on the page twice",
    );

    const rows = await waitForRows(f, served.length);
    assert.equal(rows.length, 3, "one row per served ITEM, repeats included");
    const ids = rows.map((r: any) => r.features?.recommendationId);
    assert.equal(
      new Set(ids).size, 3,
      "the same place at two rank positions is TWO exposures; one id for both under-counts the denominator",
    );
  });

  it("P2. all nine 04 §5 fields are recoverable from the rows the ROUTE wrote", async () => {
    const f = fakeClient({ mode: "legacy", serveLog: true });
    _setTestServiceClient(f.client);
    _injectTestCacheEntry(KEY, freshCandidates());

    await fetchDiscovery(url);
    const rows = await waitForRows(f, 4);
    const row = rows[1];
    assert.ok(row, "precondition: a row was written");

    for (const field of RECOMMENDATION_RECORD_FIELDS) {
      const v = fieldValue(row, field);
      assert.notEqual(
        v, undefined,
        `04 §5 minimum record: '${field}' is absent from the row the route wrote ` +
        `(expected at ${RECOMMENDATION_RECORD_LOCATION[field]})`,
      );
    }
    // `reason codes` may legitimately be the empty array on this serve point —
    // no ranker ran — but it must be PRESENT and an array, not missing. An
    // absent key and an empty one are different claims.
    assert.ok(Array.isArray(row.features.reasonCodes), "reason codes must be an array, even when empty");
    assert.equal(row.surface, "discovery", "04 §5 surface");
    assert.equal(row.position, 1, "04 §5 rank_position is the served position");
  });

  it("P3. with discovery_serve_log_enabled absent, the cache-A serve writes nothing", async () => {
    const f = fakeClient({ mode: "legacy", serveLog: false });
    _setTestServiceClient(f.client);
    _injectTestCacheEntry(KEY, freshCandidates());

    const served = await fetchDiscovery(url);
    assert.equal(served.length, 4, "the user is still served — the flag gates the LOG, not the page");
    await quiesce();
    assert.deepEqual(
      f.rankEventRows(), [],
      "a flag-off serve must write no impression row: this instrumentation changes nothing in production",
    );
  });

  // ── The REFUSAL arms. A denominator that counts refusals is not a denominator.

  it("R1. a 400 refusal is not an exposure — routes/discovery.ts:1588 writes no row", async () => {
    const f = fakeClient({ mode: "legacy", serveLog: true });
    _setTestServiceClient(f.client);
    _injectTestCacheEntry(KEY, freshCandidates());

    // No destination and no coordinates: the route's own validation arm.
    const res = await fetch(`${url}/discovery`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 400, "precondition: this is the refusal arm, not a 200 with an empty page");
    assert.equal((await res.json() as any).error, "invalid_payload");

    await quiesce();
    assert.deepEqual(
      f.rankEventRows(), [],
      "04 §5 counts items SERVED. A refused request served nothing; a row here would inflate " +
      "the exposure denominator with requests that never reached a user.",
    );
  });

  it("R2. an anonymous serve writes no exposure row — there is no viewer to attribute one to", async () => {
    const f = fakeClient({ mode: "legacy", serveLog: true });
    _setTestServiceClient(f.client);
    _injectTestCacheEntry(KEY, freshCandidates());

    const res = await fetch(`${url}/discovery?destination=Miami&lat=25.77&lng=-80.19`);
    assert.equal(res.status, 200, "precondition: anonymous callers are still served");
    const body = await res.json() as { places: Array<{ id: string }> };
    assert.equal(body.places.length, 4, "precondition: the same four places were served");

    await quiesce();
    assert.deepEqual(
      f.rankEventRows(), [],
      "the 04 §5 record is user-keyed (user_id is one of the nine). An anonymous exposure " +
      "cannot be recorded without inventing the field the record is keyed on.",
    );
  });
});

// ── G1 / G2 — the open half of DV-40, asserted rather than described ──────────

describe("04 §5 — the two RANKED serve points do not mint (census-discovery DV-40's open half)", () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startServer());
    _setTestDbPlacesOverride(async () => []);
    invalidateDiscoveryEngineModeCache();
    invalidateServeLogFlagCache();
  });
  afterEach(async () => {
    _clearTestCacheEntry(KEY);
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    invalidateDiscoveryEngineModeCache();
    invalidateServeLogFlagCache();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("G1. a pde-ranked cache-A serve writes rows with NO recommendation_id, model version or reason codes", async () => {
    const f = fakeClient({ mode: "pde", serveLog: true });
    _setTestServiceClient(f.client);
    _injectTestCacheEntry(KEY, freshCandidates());

    const served = await fetchDiscovery(url);
    assert.equal(served.length, 4, "precondition: the same four places were served");
    assert.notEqual(
      served[0], "db/p1",
      "precondition: pde actually re-ranked, so this IS the logImpression branch and not the fallback",
    );

    const rows = await waitForRows(f, served.length);
    assert.equal(rows.length, served.length, "logImpression wrote one row per served item");
    assert.equal(
      rows[0].features?.servePoint, DiscoveryServePoint.CACHE_A_L1,
      "precondition: same serve point as P1 — only the writer differs",
    );
    assert.equal(
      rows[0].features?.rankedInRequest, true,
      "precondition: this is the ranked-in-request branch",
    );

    // THE GAP. Invert these three into P1's assertions the moment
    // lib/rankLog.logImpression mints an exposure id.
    for (const row of rows) {
      assert.equal(
        row.features?.recommendationId, undefined,
        "DV-40 open half: if this now HAS an id, rankLog gained the mint — invert G1 into P1 and re-grade DV-40",
      );
      assert.equal(row.features?.modelVersion, undefined, "DV-40 open half: no model_version either");
      assert.equal(row.features?.reasonCodes, undefined, "DV-40 open half: no reason codes either");
    }
  });

  it("G2. the ranked writer is NOT gated on discovery_serve_log_enabled — the four minting points are", async () => {
    const f = fakeClient({ mode: "pde", serveLog: false });
    _setTestServiceClient(f.client);
    _injectTestCacheEntry(KEY, freshCandidates());

    await fetchDiscovery(url);
    const rows = await waitForRows(f, 1);
    assert.ok(
      rows.length > 0,
      "lib/rankLog.logImpression carries no flag: with the serve-log flag OFF these rows still land, " +
      "so 'discovery_serve_log_enabled' does not describe all six serve points",
    );
    assert.equal(rows[0].features?.recommendationId, undefined, "and still without an id");
  });
});
