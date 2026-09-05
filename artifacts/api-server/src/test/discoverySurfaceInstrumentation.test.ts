/**
 * Discovery surfaces that reported NOTHING — hidden gems and map discovery.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST
 * ==================================
 * Two surfaces returned ranked results to users and wrote no `rank_events` row
 * of any kind:
 *
 *   routes/hiddenGems.ts   GET /hidden-gems         (HiddenGemDiscoveryService
 *                          GET /hidden-gems/nearby   .discoverGems / findNearbyGems)
 *   routes/mapSearch.ts    GET /map/search          (rankResults + paginate)
 *
 * A grep of either file for logImpression / logDiscoveryServe returned nothing.
 * The consequence is not only that their impressions were missing: POST
 * /api/rank-events/outcome resolves an outcome by FINDING the impression row it
 * upgrades, so a surface with no impression row has no outcome path either. Both
 * surfaces were invisible to Discovery analytics end to end, which is exactly
 * the blindness the Stage 0 serve-point baseline (ruling D4=C — "the baseline
 * must describe everything users receive") exists to remove.
 *
 * SEARCH, SUGGEST AND COMMUNITY ARE NOT IN THIS FILE
 * ==================================================
 * They were reported alongside these two, but on current main they are ALREADY
 * instrumented — serve points 8, 9 and 10, written by routes/discoverySearch.ts
 * (logSearchServe, the /discovery/suggest tail call) and routes/discovery.ts
 * (the /discovery/community tail call). Their writes are gated on
 * discovery_serve_log_enabled, which is how every discovery serve point behaves;
 * that is a deliberate un-seeded flag, not a missing writer.
 * src/test/discoveryServePointReport.test.ts already covers them.
 *
 * WHAT IS PINNED HERE
 * ===================
 *   A. GET /hidden-gems writes one impression per served gem, at serve point 11.
 *   B. GET /hidden-gems/nearby does the same, distinguished by `route`.
 *   C. GET /map/search writes one impression per item on the SERVED PAGE — not
 *      per ranked result — at serve point 12, with each result's kind mapped.
 *   D. All of it stays behind discovery_serve_log_enabled: flag absent ⇒ no
 *      write at all, so introducing the instrumentation changes no production
 *      behaviour until the flag is deliberately turned on.
 *   E. The serve points are ranked-in-request, and no coordinate ever reaches
 *      the features blob (spec §8).
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoverySurfaceInstrumentation.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import {
  DiscoveryServePoint,
  DISCOVERY_SERVE_LOG_FLAG,
  invalidateServeLogFlagCache,
  searchTypeToItemKind,
} from "../lib/discoveryServeLog.js";

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB_ID   = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";

const LAT = 14.5995;
const LNG = 120.9842;

// ── Fixtures ──────────────────────────────────────────────────────────────────

function gemRow(n: number, overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id:                `9e000000-0000-4000-a000-00000000000${n}`,
    name:              `gem ${n}`,
    category:          "food",
    city:              "Manila",
    country:           "Philippines",
    neighborhood:      null,
    description:       "a place",
    latitude:          LAT + n * 0.001,
    longitude:         LNG + n * 0.001,
    approx_latitude:   null,
    approx_longitude:  null,
    vibe_tags:         [],
    price_range:       null,
    safety_notes:      null,
    best_time_to_go:   null,
    local_etiquette:   null,
    layover_safe:      false,
    minimum_layover_minutes: null,
    sensitivity_level: "public",
    verification_level: "unverified",
    status:            "active",
    crowd_level:       null,
    submitted_by:      BOB_ID,
    guide_verified_by: null,
    save_count:        n,
    visit_count:       0,
    report_count:      0,
    image_url:         null,
    canonical_place_id: null,
    source_type:       "traveler",
    moderation_status: "approved",
    created_at:        new Date().toISOString(),
    updated_at:        new Date().toISOString(),
    ...overrides,
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makeClient(opts: {
  gems?:  any[];
  flags?: Record<string, boolean>;
} = {}) {
  const inserts: Array<{ table: string; rows: any[] }> = [];

  const db: Record<string, any[]> = {
    hidden_gems: opts.gems ?? [],
    profiles:    [{ id: ALICE_ID, account_status: "active" }],
    blocks:      [],
    rank_events: [],
    events:      [],
  };

  function flagBuilder() {
    let flag: string | undefined;
    const fb: any = {
      select: () => fb,
      eq: (_c: string, val: string) => { flag = val; return fb; },
      maybeSingle: () => Promise.resolve({
        data: flag !== undefined && opts.flags?.[flag] !== undefined
          ? { enabled: opts.flags[flag] }
          : null,
        error: null,
      }),
      then: (res: any) => res({ data: [], error: null }),
    };
    return fb;
  }

  function builder(table: string) {
    let filtered = [...(db[table] ?? [])];
    const b: any = {
      select: (_c?: string) => builder(table),
      eq:  (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in:  (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      not: () => b,
      ilike: () => b, like: () => b, or: () => b,
      lt: () => b, lte: () => b, gt: () => b, gte: () => b,
      contains: () => b, overlaps: () => b, order: () => b, limit: () => b, range: () => b,
      is: () => b,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      insert: (data: any) => {
        const rows = Array.isArray(data) ? data : [data];
        inserts.push({ table, rows });
        for (const r of rows) (db[table] ??= []).push({ ...r });
        return Promise.resolve({ data: null, error: null });
      },
      update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      then: (res: any, rej?: any) =>
        Promise.resolve({ data: [...filtered], error: null }).then(res, rej),
    };
    return b;
  }

  const client: any = {
    auth: {
      getUser: (token?: string) =>
        token === "alice-token"
          ? Promise.resolve({ data: { user: { id: ALICE_ID } }, error: null })
          : Promise.resolve({ data: { user: null }, error: { message: "no token" } }),
    },
    from: (table: string) => (table === "feature_flags" ? flagBuilder() : builder(table)),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };

  return {
    client, inserts,
    serveRows: () =>
      inserts.filter((i) => i.table === "rank_events").flatMap((i) => i.rows),
  };
}

// ── Server harness ────────────────────────────────────────────────────────────

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const srv = createServer(app).listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      res({
        url:   `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => srv.close(() => r(undefined))),
      });
    });
  });
}

/** The serve log is written after res.json, un-awaited. Poll, don't guess. */
async function waitForRows(f: ReturnType<typeof makeClient>, atLeast: number): Promise<any[]> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const rows = f.serveRows();
    if (rows.length >= atLeast || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Give an un-awaited write a fair chance to happen when we expect NONE. */
const quiesce = () => new Promise((r) => setTimeout(r, 60));

const ALL_ON = {
  [DISCOVERY_SERVE_LOG_FLAG]: true,
  hidden_gems_enabled:        true,
  map_search_enabled:         true,
};

// ── A / B: hidden gems ────────────────────────────────────────────────────────

describe("hidden gems — the surface reported nothing", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => {
      r.log = { error() {}, info() {}, warn() {}, debug() {} }; next();
    });
    const { default: gemsRouter } = await import("../routes/hiddenGems.js");
    app.use("/api", gemsRouter);
    ({ url, close } = await startServer(app));
  });
  after(async () => { await close(); _setTestClient(null as any, false); });
  beforeEach(() => invalidateServeLogFlagCache());

  it("A. GET /hidden-gems writes one impression per served gem at serve point 11", async () => {
    const gems = [gemRow(1), gemRow(2), gemRow(3)];
    const f = makeClient({ gems, flags: ALL_ON });
    _setTestClient(f.client, true);

    const r = await fetch(`${url}/api/hidden-gems?city=Manila`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    const servedIds = (body.gems as any[]).map((g: any) => g.id as string);
    assert.equal(servedIds.length, 3, "precondition: three gems are served");

    const rows = await waitForRows(f, 3);
    assert.equal(rows.length, 3, "the surface used to write nothing at all");
    assert.deepEqual(rows.map((x: any) => x.item_id), servedIds, "one row per SERVED gem, in served order");

    for (const row of rows) {
      assert.equal(row.outcome,   "impression");
      assert.equal(row.surface,   "discovery", "the outcome route only accepts a surface it knows");
      assert.equal(row.item_kind, "gem");
      assert.equal(row.features.servePoint, DiscoveryServePoint.HIDDEN_GEMS);
      assert.equal(row.features.route, "GET /hidden-gems");
      assert.equal(row.features.rankedInRequest, true, "discoverGems ranks during the request");
    }
  });

  it("B. GET /hidden-gems/nearby is instrumented too, distinguished by route", async () => {
    const f = makeClient({ gems: [gemRow(1), gemRow(2)], flags: ALL_ON });
    _setTestClient(f.client, true);

    const r = await fetch(
      `${url}/api/hidden-gems/nearby?lat=${LAT}&lng=${LNG}&radiusKm=25`,
      { headers: { Authorization: "Bearer alice-token" } },
    );
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.equal((body.gems as any[]).length, 2);

    const rows = await waitForRows(f, 2);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.features.servePoint, DiscoveryServePoint.HIDDEN_GEMS);
      assert.equal(row.features.route, "GET /hidden-gems/nearby");
      // Spec §8: the viewer's coordinates are never logged. The radius is not a
      // location.
      for (const key of ["lat", "lng", "latitude", "longitude"]) {
        assert.ok(!(key in row.features), `${key} must never reach rank_events.features`);
      }
    }
  });

  it("D1. with discovery_serve_log_enabled absent, hidden gems write nothing", async () => {
    const f = makeClient({
      gems:  [gemRow(1)],
      flags: { hidden_gems_enabled: true },   // serve-log flag deliberately absent
    });
    _setTestClient(f.client, true);

    const r = await fetch(`${url}/api/hidden-gems?city=Manila`, {
      headers: { Authorization: "Bearer alice-token" },
    });
    assert.equal(r.status, 200);
    await quiesce();
    assert.equal(f.serveRows().length, 0, "flag absent ⇒ no write — introducing this is inert");
  });
});

// ── C: map discovery ──────────────────────────────────────────────────────────

describe("map discovery — the surface reported nothing", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => {
      r.log = { error() {}, info() {}, warn() {}, debug() {} }; next();
    });
    const { default: mapRouter } = await import("../routes/mapSearch.js");
    app.use("/api", mapRouter);
    ({ url, close } = await startServer(app));
  });
  after(async () => { await close(); _setTestClient(null as any, false); });
  beforeEach(() => invalidateServeLogFlagCache());

  it("C. GET /map/search writes one impression per item on the SERVED PAGE, at serve point 12", async () => {
    const gems = [gemRow(1), gemRow(2), gemRow(3), gemRow(4)];
    const f = makeClient({ gems, flags: ALL_ON });
    _setTestClient(f.client, true);

    // limit=2 with 4 rankable gems: the served page is strictly smaller than the
    // ranked set, which is the distinction an impression has to respect.
    const r = await fetch(
      `${url}/api/map/search?lat=${LAT}&lng=${LNG}&radiusKm=50&types=gem&limit=2`,
      { headers: { Authorization: "Bearer alice-token" } },
    );
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.equal(body.enabled, true);
    const servedIds = (body.results as any[]).map((x: any) => x.id as string);
    assert.equal(servedIds.length, 2, "precondition: the page is 2 of 4 ranked results");
    assert.equal(body.total, 4, "precondition: 4 were ranked");

    const rows = await waitForRows(f, 2);
    assert.equal(
      rows.length, 2,
      "an impression is what the viewer received — the served page, not the ranked set",
    );
    assert.deepEqual(rows.map((x: any) => x.item_id), servedIds);
    for (const row of rows) {
      assert.equal(row.outcome,   "impression");
      assert.equal(row.surface,   "discovery");
      assert.equal(row.item_kind, "gem");
      assert.equal(row.features.servePoint, DiscoveryServePoint.MAP_SEARCH);
      assert.equal(row.features.route, "GET /map/search");
      assert.equal(row.features.rankedInRequest, true, "rankResults ranks during the request");
      for (const key of ["lat", "lng", "latitude", "longitude"]) {
        assert.ok(!(key in row.features), `${key} must never reach rank_events.features`);
      }
    }
  });

  it("D2. with discovery_serve_log_enabled absent, map search writes nothing", async () => {
    const f = makeClient({
      gems:  [gemRow(1)],
      flags: { map_search_enabled: true },    // serve-log flag deliberately absent
    });
    _setTestClient(f.client, true);

    const r = await fetch(
      `${url}/api/map/search?lat=${LAT}&lng=${LNG}&radiusKm=50&types=gem`,
      { headers: { Authorization: "Bearer alice-token" } },
    );
    assert.equal(r.status, 200);
    await quiesce();
    assert.equal(f.serveRows().length, 0);
  });
});

// ── E: the kind mapping both surfaces share ───────────────────────────────────

describe("searchTypeToItemKind — map result types", () => {
  it("E. maps MapSearchResult.resultType onto the same item_kind search uses", () => {
    // lib/mapSearch.ts emits singular resultTypes; /discovery/search emits
    // plurals. One entity must land on ONE item_kind or every per-kind rollup
    // counts it twice under two names.
    assert.equal(searchTypeToItemKind("traveler"), searchTypeToItemKind("travelers"));
    assert.equal(searchTypeToItemKind("gem"),      searchTypeToItemKind("hidden_gems"));
    assert.equal(searchTypeToItemKind("event"),    searchTypeToItemKind("events"));
    assert.equal(searchTypeToItemKind("traveler"), "buddy");
    assert.equal(searchTypeToItemKind("gem"),      "gem");
    assert.equal(searchTypeToItemKind("event"),    "event");
    // Unmapped stays null — 'kind not applicable' is a real answer and inventing
    // one would corrupt every group-by.
    assert.equal(searchTypeToItemKind("circle"), null);
  });

  it("E2. serve points 11 and 12 exist and are distinct", () => {
    assert.equal(DiscoveryServePoint.HIDDEN_GEMS, 11);
    assert.equal(DiscoveryServePoint.MAP_SEARCH,  12);
  });
});
