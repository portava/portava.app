/**
 * VERIFICATION LANE V3 — FLOW 2: "NOT INTERESTED", TAP TO SUPPRESSION.
 *
 * The control promises one thing: the card goes away and STAYS away. This file
 * drives that promise end to end, through TWO REAL ROUTERS on ONE express app
 * over ONE mutable in-memory PostgREST-shaped store:
 *
 *   1. POST /api/rank-events/outcome  {outcome: "dismiss", surface: "discovery"}
 *                                                       (routes/rankEvents.ts)
 *      → the impression row for (viewer, item, discovery) is UPDATED in place
 *   2. GET  /api/discovery                               (routes/discovery.ts)
 *      → `dismissGatedPlaces` → `loadDismissedPlaceIds` reads that same row
 *      → the place is gone, ON EVERY ONE OF THE FOUR SERVE PATHS
 *
 * WHY THE WRITE IS DRIVEN AND NOT SEEDED. Seeding a `rank_events` row with
 * `outcome: 'dismiss'` would test the READER alone and would be green even if
 * the outcome route wrote the wrong `item_id`, the wrong `surface`, or refused
 * the dismissal entirely. The item-id spelling is the seam that matters: the
 * serve log writes `item_id: item.id` and the suppression filter matches on
 * `place.id`, and NOTHING in either module forces those to be the same string.
 * `discovery_places` rows are served with ids like `db/<slug>`, OSM rows as
 * `node/<n>`; a writer that normalised either would suppress nothing and no
 * existing test would notice.
 *
 * WHY ALL FOUR SERVE PATHS. `routes/discovery.ts` says it itself: "a dismissal
 * honoured on the cold path and forgotten on a cache hit is worse than one that
 * is never honoured at all — the place disappears, the person believes the
 * control works, and then it comes back on a request that differs only in which
 * cache answered". The four paths are reached and RECOGNISED from the envelope
 * (not assumed), using the same discriminator
 * `src/test/discoveryCuratedSourceRefusal.test.ts` established, because every
 * Compass branch in the route swallows its own errors and falls through to the
 * cold path — a fixture that cannot carry the pipeline answers from a DIFFERENT
 * path rather than failing, and a case that did not check would be about a path
 * it never reached.
 *
 * ── WHAT IS NOT EXERCISED ──────────────────────────────────────────────────
 * Migration 2297 (`rank_events.outcome` admitting `'dismiss'`) IS applied; the
 * route's own header records it as a hard precondition. The store below
 * enforces no CHECK, so this file cannot tell an applied 2297 from an
 * unapplied one — it asserts the code paths agree, not that the database
 * admits the value. `content_distribution_stats.negative_signal_count`, the
 * CROSS-VIEWER half of a dismiss, is `discoveryNegativeSignalWriter.test.ts`'s
 * subject and is not re-pinned here; this file is about the promise made to
 * the person who tapped.
 *
 * SHOWN RED BEFORE GREEN — see the mutation log at the foot of this file.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verifyFlowDiscoveryDismissal.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import pino from "pino";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import discoveryRouter, {
  _setTestDbPlacesOverride,
  _injectTestCacheEntry,
  _clearTestCacheEntry,
  _clearTestCompassCache,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import rankEventsRouter, { _resetRecommendationIdSchemaLatch } from "../routes/rankEvents.js";
import { invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { DISMISSED_OUTCOME, DISMISSED_SURFACE } from "../lib/discoveryDismissed.js";

// No network: Overpass and Nominatim throw immediately rather than hanging.
// Every case supplies lat/lng, so the route never needs to geocode.
const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) {
    throw new Error("Network blocked in test environment");
  }
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

const VIEWER_TOKEN = "dismissal-viewer";
const VIEWER_ID = "cccc0000-0000-0000-0000-00000000dead";
const OTHER_ID = "cccc0000-0000-0000-0000-00000000beef";

/** The place the viewer waves away, and the one that must survive beside it. */
const DISMISSED_ID = "db/the-tourist-trap";
const KEPT_ID = "db/the-good-one";

const MIAMI = "destination=Miami&lat=25.77&lng=-80.19&radiusKm=10";
const CACHE_A_FOOD = "miami:food:10";

const COMPASS_ON_FLAGS = [
  { flag: "discovery_serve_log_enabled", enabled: true },
  { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true },
];

function curatedPlace(id: string, savedCount: number): DiscoveryPlace {
  return {
    id, name: id, category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1, lat: 25.77, lng: -80.19, tags: [],
    address: "Miami, FL", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount,
  } as DiscoveryPlace;
}

/**
 * The impression row the serve log wrote when this place was last shown.
 * `item_id` is spelled EXACTLY as `logDiscoveryServe` spells it (`item.id`),
 * which is the whole point of the seam under test.
 */
function impression(itemId: string, userId = VIEWER_ID, servedAt = "2026-09-01T00:00:00.000Z") {
  return {
    id: `imp-${userId.slice(-4)}-${itemId}`,
    user_id: userId,
    item_id: itemId,
    surface: "discovery",
    outcome: "impression",
    outcome_at: null,
    served_at: servedAt,
    session_id: null,
    position: 0,
    features: {},
    recommendation_id: null,
  };
}

// ── the fake: MUTABLE, because the write half has to land somewhere ──────────

interface FakeOpts {
  rows?: Record<string, any[]>;
  errorTables?: string[];
}

let store: Record<string, any[]> = {};

function buildFakeClient(opts: FakeOpts = {}) {
  const errorTables = new Set(opts.errorTables ?? []);
  store = {
    feature_flags: [{ flag: "discovery_serve_log_enabled", enabled: true }],
    rank_events: [],
    ...Object.fromEntries(Object.entries(opts.rows ?? {}).map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
  };

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let pendingRows: any[] = [];
    let pendingPatch: any = null;
    let _limit: number | null = null;
    let _order: { col: string; asc: boolean } | null = null;

    const rows = (): any[] => {
      let out = (store[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (_order) {
        const { col, asc } = _order;
        out = [...out].sort((a, b) => {
          const x = Date.parse(a?.[col]) || 0;
          const y = Date.parse(b?.[col]) || 0;
          return asc ? x - y : y - x;
        });
      }
      return _limit !== null ? out.slice(0, _limit) : out;
    };

    const applyWrite = (): any[] => {
      store[table] = store[table] ?? [];
      if (mode === "insert" || mode === "upsert") {
        const written = pendingRows.map((r, i) => ({ id: r.id ?? `gen-${table}-${store[table].length + i}`, ...r }));
        store[table].push(...written);
        return written;
      }
      if (mode === "update") {
        const target = (store[table] ?? []).filter((r) => preds.every((p) => p(r)));
        for (const r of target) Object.assign(r, pendingPatch);
        return target;
      }
      const doomed = (store[table] ?? []).filter((r) => preds.every((p) => p(r)));
      store[table] = (store[table] ?? []).filter((r) => !doomed.includes(r));
      return doomed;
    };

    const settle = () => {
      if (errorTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      if (mode === "select") {
        const out = rows();
        return { data: out, error: null, count: out.length };
      }
      const written = applyWrite();
      return { data: written, error: null, count: written.length };
    };

    const b: any = {
      select() { return b; },
      insert(r: any) { mode = "insert"; pendingRows = Array.isArray(r) ? r : [r]; return b; },
      upsert(r: any) { mode = "upsert"; pendingRows = Array.isArray(r) ? r : [r]; return b; },
      update(patch: any) { mode = "update"; pendingPatch = patch; return b; },
      delete() { mode = "delete"; return b; },
      eq(col: string, val: any) { preds.push((r) => String(r?.[col]) === String(val)); return b; },
      neq(col: string, val: any) { preds.push((r) => String(r?.[col]) !== String(val)); return b; },
      in(col: string, vals: any[]) {
        const set = (vals ?? []).map(String);
        preds.push((r) => set.includes(String(r?.[col])));
        return b;
      },
      is(col: string, val: any) { preds.push((r) => (val === null ? r?.[col] == null : r?.[col] === val)); return b; },
      not() { return b; }, gt() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; },
      or() { return b; }, ilike() { return b; }, contains() { return b; }, overlaps() { return b; },
      range() { return b; },
      // `fetchCompassFlags` selects the COMPASS_% family with `.like()`. The
      // pattern is honoured rather than stubbed true, so a case cannot switch on
      // a flag it did not seed.
      like(col: string, pattern: string) {
        const rx = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
        preds.push((r) => typeof r[col] === "string" && rx.test(r[col]));
        return b;
      },
      order(col: string, o?: any) { _order = { col, asc: o?.ascending !== false }; return b; },
      limit(n: number) { _limit = n; return b; },
      maybeSingle() {
        const s = settle();
        return Promise.resolve({ data: s.error ? null : (Array.isArray(s.data) ? s.data[0] ?? null : s.data), error: s.error });
      },
      single() {
        const s = settle();
        return Promise.resolve({ data: s.error ? null : (Array.isArray(s.data) ? s.data[0] ?? null : s.data), error: s.error });
      },
      then(onF: any, onR: any) { return Promise.resolve(settle()).then(onF, onR); },
    };
    return b;
  }

  return {
    auth: {
      getUser: async (token: string) =>
        token === VIEWER_TOKEN
          ? { data: { user: { id: VIEWER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
    from,
    rpc: async () => ({ data: null, error: null }),
  };
}

function setClient(opts: FakeOpts = {}) {
  const fc = buildFakeClient(opts);
  _setTestClient(fc as any, true);
  _setTestServiceClient(fc as any);
}

let server: http.Server;
let base = "";

function get(path: string, auth = true): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method: "GET",
        headers: auth ? { authorization: `Bearer ${VIEWER_TOKEN}` } : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

async function post(path: string, body: unknown, token = VIEWER_TOKEN) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}

/** The tap. Exactly the request `useRankOutcome#reportDismiss` builds. */
function tapNotInterested(itemId: string) {
  return post("/api/rank-events/outcome", {
    item_id: itemId,
    surface: DISMISSED_SURFACE,
    outcome: DISMISSED_OUTCOME,
  });
}

/** Which of the four serve paths answered — read off the envelope, never assumed. */
function servePathOf(body: any): string {
  const level = body?.meta?.cacheLevel;
  if (level === "error") return "assembly_error";
  if (body?.cached === true) return typeof level === "string" ? "cache_a" : "compass_hit";
  if (level === "miss") return "cold";
  if (body?.cached === false && level === undefined) return "compass_fresh";
  return `unrecognised(${JSON.stringify(body?.cached)}/${JSON.stringify(level)})`;
}

function assertServePath(body: any, expected: string): void {
  assert.equal(
    servePathOf(body), expected,
    `this case did not reach the serve path it is about (it reached ${servePathOf(body)}), ` +
    `so whatever it asserts is about a different path. Body keys: ` +
    `${JSON.stringify(Object.keys(body ?? {}))}`,
  );
}

const idsOf = (body: any): string[] => (body?.places ?? []).map((p: any) => p.id);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", rankEventsRouter);
  app.use("/api", discoveryRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  server.close();
  globalThis.fetch = _originalFetch;
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  _setTestDbPlacesOverride(null);
});

beforeEach(() => {
  // Module-level memoisations with their own TTLs. Without these the first
  // fixture to be asked decides the answer for every case inside the window —
  // including whether Compass is on at all.
  invalidateServeLogFlagCache();
  invalidateFlagsCache();
  invalidateDiscoveryEngineModeCache();
  _resetRecommendationIdSchemaLatch();
  _clearTestCompassCache();
  _clearTestCacheEntry(CACHE_A_FOOD);
});
afterEach(() => {
  _setTestDbPlacesOverride(null);
  _clearTestCacheEntry(CACHE_A_FOOD);
  _clearTestCompassCache();
});

// ── LEG 1: the tap writes ────────────────────────────────────────────────────

describe("FLOW 2 leg 1 — the tap reaches rank_events and says 'dismiss'", () => {
  it("UPDATES the viewer's own impression row in place; it does not insert a second one", async () => {
    setClient({ rows: { rank_events: [impression(DISMISSED_ID), impression(KEPT_ID)] } });

    const r = await tapNotInterested(DISMISSED_ID);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);

    // `rank_events` is a MUTABLE-STATE table: one row per (user, item,
    // surface), holding the furthest rung reached. A dismiss that inserted a
    // second row would double-count the impression denominator.
    const funnelRows = store.rank_events.filter((e: any) => e.outcome !== "analytics");
    assert.equal(funnelRows.length, 2, "the dismiss wrote a new funnel row instead of upgrading one");

    const row = funnelRows.find((e: any) => e.item_id === DISMISSED_ID);
    assert.equal(row.outcome, "dismiss");
    assert.equal(row.surface, "discovery");
    assert.equal(row.user_id, VIEWER_ID);
    assert.ok(row.outcome_at, "the dismiss must be timed");

    const untouched = funnelRows.find((e: any) => e.item_id === KEPT_ID);
    assert.equal(untouched.outcome, "impression", "the dismiss touched a place nobody dismissed");
  });

  it("the item_id it writes is the SPELLING the serve path uses, character for character", async () => {
    // The seam. The serve log writes `item.id`; the suppression filter matches
    // `place.id`. Both are `db/<slug>` / `node/<n>` strings that look like they
    // want normalising, and neither module would notice if one side did.
    setClient({ rows: { rank_events: [impression(DISMISSED_ID)] } });
    await tapNotInterested(DISMISSED_ID);
    const row = store.rank_events.find((e: any) => e.outcome === "dismiss");
    assert.equal(row.item_id, DISMISSED_ID);
    assert.ok(row.item_id.includes("/"), "precondition: this is a prefixed id, not a bare uuid");
  });

  it("REFUSES a dismissal with no impression to attach it to, and writes nothing", async () => {
    // `useRankOutcome#reportDismiss` treats this 404 as a failure and KEEPS the
    // card, deliberately: a suppression list is built from dismiss rows, so a
    // dismissal with no row suppresses nothing, and hiding the card would be
    // exactly the lie the awaited control exists to avoid.
    setClient({ rows: { rank_events: [] } });
    const r = await tapNotInterested(DISMISSED_ID);
    assert.equal(r.status, 404, r.raw);
    assert.equal(r.body.error, "not_found");
    assert.deepEqual(store.rank_events.filter((e: any) => e.outcome === "dismiss"), []);
  });

  it("is TERMINAL: a later save cannot overwrite a recorded dismiss", async () => {
    setClient({ rows: { rank_events: [impression(DISMISSED_ID)] } });
    assert.equal((await tapNotInterested(DISMISSED_ID)).status, 200);

    const save = await post("/api/rank-events/outcome", {
      item_id: DISMISSED_ID, surface: "discovery", outcome: "save",
    });
    assert.equal(save.status, 404, "a save found an upgradable row and overwrote the dismiss");
    const row = store.rank_events.find((e: any) => e.item_id === DISMISSED_ID && e.outcome !== "analytics");
    assert.equal(row.outcome, "dismiss", "the negative signal was silently replaced by a positive one");
  });
});

// ── LEG 2: the next serve honours it, on all four paths ──────────────────────

describe("FLOW 2 leg 2 — the NEXT serve suppresses it, on every serve path", () => {
  /**
   * Seed impressions, drive the real dismiss through the real route, and hand
   * back a helper that serves Discovery. The dismiss row and the serve read the
   * SAME store, which is what makes this a flow and not two unit tests.
   */
  async function dismissThenServe(opts: { flags?: any[] } = {}) {
    setClient({
      rows: {
        feature_flags: opts.flags ?? [{ flag: "discovery_serve_log_enabled", enabled: true }],
        rank_events: [impression(DISMISSED_ID), impression(KEPT_ID)],
      },
    });
    const tap = await tapNotInterested(DISMISSED_ID);
    assert.equal(tap.status, 200, `precondition: the dismiss must be accepted — ${tap.raw}`);
    _setTestDbPlacesOverride(async () => [curatedPlace(DISMISSED_ID, 10), curatedPlace(KEPT_ID, 9)]);
  }

  it("1/4 cold fetch: the dismissed place is gone and the other one is not", async () => {
    await dismissThenServe();
    const r = await get(`/api/discovery?${MIAMI}&category=for_you`);
    assert.equal(r.status, 200);
    assertServePath(r.body, "cold");
    const ids = idsOf(r.body);
    assert.ok(ids.includes(KEPT_ID), `precondition: this fixture must serve ${KEPT_ID} — got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes(DISMISSED_ID), `"Not interested" did not remove the place: ${JSON.stringify(ids)}`);
  });

  it("2/4 cache-A serve: a page replayed from the L1 cache is filtered too", async () => {
    // The nastiest of the four. The cached page was assembled BEFORE the
    // dismissal existed, so a gate applied only at assembly time would serve
    // the dismissed place back — on a request that differs from the last one
    // only in which cache answered.
    await dismissThenServe();
    _injectTestCacheEntry(CACHE_A_FOOD, [curatedPlace(DISMISSED_ID, 10), curatedPlace(KEPT_ID, 9)]);
    const r = await get(`/api/discovery?${MIAMI}&category=food`);
    assert.equal(r.status, 200);
    assertServePath(r.body, "cache_a");
    const ids = idsOf(r.body);
    assert.ok(ids.includes(KEPT_ID), `precondition: the cached page must carry ${KEPT_ID} — got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes(DISMISSED_ID), `a cache hit resurrected a dismissed place: ${JSON.stringify(ids)}`);
  });

  it("3/4 Compass fresh rank: the ranked page is filtered too", async () => {
    await dismissThenServe({ flags: COMPASS_ON_FLAGS });
    const r = await get(`/api/discovery?${MIAMI}&category=for_you`);
    assert.equal(r.status, 200);
    assertServePath(r.body, "compass_fresh");
    const ids = idsOf(r.body);
    assert.ok(ids.includes(KEPT_ID), `precondition: the ranked page must carry ${KEPT_ID} — got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes(DISMISSED_ID), `the Compass rank served a dismissed place: ${JSON.stringify(ids)}`);
  });

  it("4/4 Compass cache-B hit: the stored per-user ranked page is filtered too", async () => {
    await dismissThenServe({ flags: COMPASS_ON_FLAGS });
    const first = await get(`/api/discovery?${MIAMI}&category=for_you`);
    assertServePath(first.body, "compass_fresh");

    const r = await get(`/api/discovery?${MIAMI}&category=for_you`);
    assert.equal(r.status, 200);
    assertServePath(r.body, "compass_hit");
    const ids = idsOf(r.body);
    assert.ok(ids.includes(KEPT_ID), `precondition: the replayed page must carry ${KEPT_ID} — got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes(DISMISSED_ID), `a cache-B hit resurrected a dismissed place: ${JSON.stringify(ids)}`);
  });

  it("STAYS away — a second serve, and a third, still omit it", async () => {
    // "No window, on purpose": a dismissal is not a statement about recency.
    // A filter that expired would resurrect every rejected place on a schedule
    // nobody was told about.
    await dismissThenServe();
    for (const n of [1, 2, 3]) {
      _clearTestCompassCache();
      const r = await get(`/api/discovery?${MIAMI}&category=for_you`);
      assert.ok(!idsOf(r.body).includes(DISMISSED_ID), `serve ${n} brought the dismissed place back`);
    }
  });
});

// ── the controls that stop this passing vacuously ────────────────────────────

describe("FLOW 2 controls — the suppression is caused by the dismissal and by nothing else", () => {
  it("CONTROL: with NO dismissal, the same fixture serves BOTH places", async () => {
    // Without this, every case above would pass against a route that served an
    // empty page, or against a fixture that never carried the dismissed place.
    setClient({ rows: { rank_events: [impression(DISMISSED_ID), impression(KEPT_ID)] } });
    _setTestDbPlacesOverride(async () => [curatedPlace(DISMISSED_ID, 10), curatedPlace(KEPT_ID, 9)]);
    const r = await get(`/api/discovery?${MIAMI}&category=for_you`);
    assertServePath(r.body, "cold");
    const ids = idsOf(r.body);
    assert.ok(ids.includes(DISMISSED_ID), "the fixture never served the place the other cases claim was removed");
    assert.ok(ids.includes(KEPT_ID));
  });

  it("CONTROL: one person's dismissal does not change ANOTHER person's results", async () => {
    // `loadDismissedPlaceIds` is keyed to the caller. A filter keyed only on
    // item_id would be a stranger editing your feed.
    setClient({
      rows: {
        rank_events: [
          { ...impression(DISMISSED_ID, OTHER_ID), outcome: "dismiss", outcome_at: "2026-09-02T00:00:00.000Z" },
          impression(DISMISSED_ID, VIEWER_ID),
          impression(KEPT_ID, VIEWER_ID),
        ],
      },
    });
    _setTestDbPlacesOverride(async () => [curatedPlace(DISMISSED_ID, 10), curatedPlace(KEPT_ID, 9)]);
    const r = await get(`/api/discovery?${MIAMI}&category=for_you`);
    const ids = idsOf(r.body);
    assert.ok(
      ids.includes(DISMISSED_ID),
      "somebody else's dismissal removed a place from this viewer's feed",
    );
  });

  it("CONTROL: a dismissal on ANOTHER SURFACE does not suppress on discovery", async () => {
    // `surface` is a key space, not a label. A pulse dismissal leaking into the
    // discovery filter would make the two feeds edit each other.
    setClient({
      rows: {
        rank_events: [
          { ...impression(DISMISSED_ID), surface: "pulse", outcome: "dismiss", outcome_at: "2026-09-02T00:00:00.000Z" },
          impression(KEPT_ID),
        ],
      },
    });
    _setTestDbPlacesOverride(async () => [curatedPlace(DISMISSED_ID, 10), curatedPlace(KEPT_ID, 9)]);
    const r = await get(`/api/discovery?${MIAMI}&category=for_you`);
    assert.ok(idsOf(r.body).includes(DISMISSED_ID), "a dismissal on `pulse` suppressed a place on `discovery`");
  });

  it("an UNREADABLE dismissal list serves the page and SAYS SO — it neither hides nor pretends", async () => {
    // Both failure directions are bad and the module picks the smaller one on
    // purpose: fail-open shows places the viewer removed, fail-closed shows an
    // EMPTY Discovery tab because a preference list blipped. The cost of the
    // choice is carried OUT on the envelope rather than swallowed.
    setClient({
      rows: { rank_events: [impression(DISMISSED_ID), impression(KEPT_ID)] },
      errorTables: ["rank_events"],
    });
    _setTestDbPlacesOverride(async () => [curatedPlace(DISMISSED_ID, 10), curatedPlace(KEPT_ID, 9)]);
    const r = await get(`/api/discovery?${MIAMI}&category=for_you`);
    assert.equal(r.status, 200, "an unreadable preference list must not empty the Discovery tab");
    assert.ok(idsOf(r.body).length > 0, "the page was withheld over a ranking-preference read");
    assert.equal(
      r.body?.refusal?.code, "dismissed_set_read_failed",
      `the response does not name the dismissal read as the thing that failed, so the ` +
      `page claims a filter it did not apply. refusal=${JSON.stringify(r.body?.refusal)}`,
    );
    assert.equal(r.body?.refusal?.coverage, "partial", "the page is served, and stated as partial");
    assert.ok(
      (r.body?.refusal?.failedSources ?? []).includes("rank_events"),
      "the refusal must NAME the table whose rows are missing",
    );
  });
});

/**
 * MUTATIONS RUN, WITH THE COUNTS THEY PRODUCED. Baseline 13/13. Every mutant
 * was applied to the tree, the suite re-run, and the file restored from a
 * byte-for-byte copy; `git status` was clean of source changes at the end.
 *
 *   • `routes/rankEvents.ts` — the outcome handler NORMALISING `item_id`
 *     (`"db/the-tourist-trap"` → `"the-tourist-trap"`) before the lookup →
 *     5/8. Eight of thirteen. THIS IS THE SEAM THE FILE EXISTS FOR, and the
 *     mutation is not a strawman: `item_id` is declared `z.string()` precisely
 *     because Discovery ids are prefixed, and a later reader tidying "db/" off
 *     an id would break the dismissal for every curated place while every
 *     existing rank-events test stayed green.
 *   • `routes/discovery.ts` — `dismissGatedPlaces` removed from serve path 4 of
 *     4 (the cold fetch, `dismD`) → 10/3: the cold case, the stays-away case
 *     and the Compass-fresh case, which also lands there under this fixture.
 *   • The same removal on serve path 1 (`dismA`, live rank) → 12/1.
 *   • The same removal on serve path 2 (`dismB`, cache-A / Compass) → 12/1.
 *   • The same removal on serve path 3 (`dismC`) → 12/1.
 *     Four separate mutations rather than one, because "all four call it" is
 *     the route's own stated invariant and a single case that happened to
 *     cover one path would have proved nothing about the other three.
 *   • `lib/discoveryDismissed.ts` — `.eq("user_id", userId)` dropped from the
 *     read → 12/1, on the cross-viewer control. A stranger's "Not interested"
 *     starts editing your feed.
 *   • `lib/discoveryDismissed.ts` — `.eq("surface", DISMISSED_SURFACE)` dropped
 *     → 12/1, on the surface control. A Pulse dismissal leaks into Discovery.
 *   • `lib/discoveryDismissed.ts` — the `if (error)` arm returning
 *     `degraded: false` instead of `true` → 12/1, on the unreadable-list case.
 *     The page is served with no filter applied and says nothing about it,
 *     which is precisely "a failure masquerading as success".
 *   • `routes/rankEvents.ts` — `upgradableOutcomesFor` returning `dismiss`
 *     among every outcome's upgradable set → 12/1, on the terminal case. A
 *     later save silently replaces a recorded negative.
 *
 * ONE MUTANT THAT DID NOT REDDEN:
 *
 *   • `upgradableOutcomesFor(DISMISS)` widened from `["impression"]` to
 *     `["impression", "tap", "save"]` → 13/13. That widening changes which
 *     rows a dismiss may ATTACH to, and every case here dismisses a row still
 *     at `impression`. It is the other half of the terminal rule and is
 *     already pinned by `src/test/discoveryNegativeSignalWriter.test.ts`
 *     section A; naming it here rather than adding a duplicate case.
 */
