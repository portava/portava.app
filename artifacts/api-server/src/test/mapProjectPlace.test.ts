/**
 * mapProjectPlace — canonical places through the Map Intelligence Gateway
 * (Map spec §7, §8, §19, §24, §25, §31).
 *
 * WHAT THIS SUITE IS FOR
 * ======================
 * Until this landed the gateway had no `place` producer at all: routes/
 * mapProjection.ts never `wantKind("place")`, so every canonical place on the
 * map arrived through the legacy per-screen fetch and skipped §24 protection,
 * §31 aggregation and §7 enrichment. The load-bearing tests here are therefore
 * the ROUTE-LEVEL ones: a real place row driven through the real HTTP handler,
 * asserting that each of those three stages actually acted on it —
 *
 *   • a place inside a private residence zone is SUPPRESSED, one inside a
 *     medical-facility zone is COARSENED (§24);
 *   • at world and city bands places collapse into `activity_zone` cells, and
 *     a cell under the k floor is withheld, never drawn small (§31);
 *   • a live crowd claim keyed on `places.id` reaches the object as §7's
 *     activity / trend / freshness / confidence axes and §9's Why? lines.
 *
 * The unit half pins the projector's own contract: it echoes the coordinate,
 * asserts no intelligence of its own (§37), records the id bridge, and reads
 * only the columns the viewport query selects — the guard that would have
 * caught projectGem's `thumbnail_url`.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapProjectPlace.test.ts
 */
import { describe, it, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _setTestClient } from "../lib/http.js";
import mapProjectionRouter, { _clearProtectedZoneCache } from "../routes/mapProjection.js";
import { _clearPromotedScopeCache, toLiveClaimEnvelope, type LiveClaim } from "../lib/liveClaimRead.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import {
  MAX_PLACE_ROWS,
  PLACE_PRIVACY_CLASS,
  PLACE_SELECT_COLUMNS,
  discoveryServedIdFor,
  loadViewportPlaceRows,
  placeDetailRoute,
  projectPlace,
  type PlaceRowLike,
} from "../lib/mapProjectPlace.js";
import { applyLiveClaims, liveSubjectIdFor, type LiveClaimLike } from "../lib/mapProjection.js";
import {
  KIND_DEFAULT_PRIORITY,
  RENDERING_PRIORITY,
  deriveFreshness,
  isServable,
  type MapObject,
} from "../lib/mapObjects.js";
import { MIN_ZONE_COHORT, cellFor, zoomBandFor } from "../lib/mapAggregation.js";
import { CONFIDENCE_BAND_FLOOR } from "../lib/intelContracts.js";
import { mapQuickSignal } from "../lib/quickSignal.js";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── ids ───────────────────────────────────────────────────────────────────────

const TOKEN = "place-projector-token";
const USER = "aaaa1111-0000-0000-0000-00000000000a";
/** A second viewer with its own rate-limit bucket, for the limit test alone. */
const TOKEN_RL = "place-projector-rl-token";
const USER_RL = "aaaa1111-0000-0000-0000-00000000000b";

const P1 = "dddddddd-0000-0000-0000-0000000000p1";

/** A deliberately distinctive coordinate, so a leak is greppable. */
const RAW = { lat: 16.054412, lng: 108.202233 };

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A `places` row as PLACE_SELECT_COLUMNS returns it. */
function placeRow(over: Partial<PlaceRowLike> & { id?: string } = {}): PlaceRowLike {
  return {
    id: P1,
    name: "Han Market",
    primary_category: "night_market",
    city: "Da Nang",
    neighborhood: "Hai Chau",
    country_code: "VN",
    latitude: RAW.lat,
    longitude: RAW.lng,
    status: "active",
    merged_into_place_id: null,
    ...over,
  };
}

/**
 * `n` distinct active places on a √n × √n grid of 0.0001° (~11 m) steps
 * starting AT RAW — Place 1 sits exactly on RAW. Even the largest cluster this
 * suite builds (MAX_PLACE_ROWS + 1 → a 32 × 32 grid, ~0.003°) stays inside the
 * DISTRICT viewport and inside one aggregation cell at every aggregating zoom.
 * The previous 0.001° column-major spread walked 1,001 rows 0.2° east, out of
 * the viewport, so the truncation test read 240 rows and could never truncate.
 */
function placeCluster(n: number): PlaceRowLike[] {
  const side = Math.ceil(Math.sqrt(n));
  return Array.from({ length: n }, (_, i) =>
    placeRow({
      id: `dddddddd-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
      name: `Place ${i + 1}`,
      latitude: RAW.lat + (i % side) * 0.0001,
      longitude: RAW.lng + Math.floor(i / side) * 0.0001,
    }),
  );
}

/** The gateway flag ON. */
const PROJECTION_ON = [{ flag: "map_projection_enabled", enabled: true }];

/** The whole Live-label flag chain lib/liveClaimRead gates on. */
const LIVE_LABELS_ON = [
  ...PROJECTION_ON,
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];

const ZONE = "zone-hai-chau";

/**
 * Two live snapshots for P1 — a level and a trajectory — in the shape
 * intel_state_snapshots holds them. The claim VALUES come from the production
 * mapper (`mapQuickSignal`), not from a hand-written literal: that is how this
 * repo learned §7's Activity axis had never fired against real data.
 */
function liveSnapshots(nowMs: number) {
  const level = mapQuickSignal("arrival", "busy")!;
  const trajectory = mapQuickSignal("inside", "building")!;
  const observed = new Date(nowMs - 2 * 60_000).toISOString();
  const expires = new Date(nowMs + 30 * 60_000).toISOString();
  const base = {
    subject_id: P1,
    zone_id: ZONE,
    confidence: CONFIDENCE_BAND_FLOOR.live + 0.05,
    source_count: 30,
    observed_at: observed,
    expires_at: expires,
    privacy_eligible: true,
  };
  return {
    scopes: [
      { scope_key: `${ZONE}|${level.claimType}` },
      { scope_key: `${ZONE}|${trajectory.claimType}` },
    ],
    snapshots: [
      { id: "snap-level", claim_type: level.claimType, value: level.value, ...base },
      { id: "snap-trend", claim_type: trajectory.claimType, value: trajectory.value, ...base },
    ],
  };
}

/** A circular §24 zone centred on RAW, as `protected_zones` stores it. */
function zoneRow(category: string, over: Record<string, unknown> = {}) {
  return {
    id: `zone-${category}`,
    category,
    action: null,
    privacy_floor: null,
    shape: "circle",
    center_lat: RAW.lat + 0.0005,
    center_lng: RAW.lng + 0.0005,
    radius_meters: 500,
    ring: null,
    jurisdiction: null,
    policy_ref: null,
    active: true,
    ...over,
  };
}

// ── fake Supabase client ──────────────────────────────────────────────────────

interface TableSpec {
  rows?: any[];
  /** When set, every read of this table returns this error (data null). */
  error?: { message: string };
}
type FakeState = Record<string, TableSpec | any[]>;

function specOf(state: FakeState, table: string): TableSpec {
  const v = state[table];
  if (Array.isArray(v)) return { rows: v };
  return v ?? { rows: [] };
}

/**
 * A chainable PostgREST-ish query over in-memory rows. Only the operators the
 * code under test actually uses are implemented, so an unimplemented one throws
 * rather than silently passing.
 */
function buildQuery(spec: TableSpec) {
  let rows = [...(spec.rows ?? [])];
  const err = spec.error ?? null;
  const result = () => (err ? { data: null, error: err } : { data: rows, error: null });

  const q: any = {
    select() { return q; },
    order() { return q; },
    limit(n: number) { rows = rows.slice(0, n); return q; },
    range() { return q; },
    eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); return q; },
    neq(col: string, val: any) { rows = rows.filter((r) => r[col] !== val); return q; },
    in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
    gte(col: string, val: any) { rows = rows.filter((r) => r[col] >= val); return q; },
    lte(col: string, val: any) { rows = rows.filter((r) => r[col] <= val); return q; },
    gt(col: string, val: any) { rows = rows.filter((r) => r[col] > val); return q; },
    is(col: string, val: any) {
      if (val === null) rows = rows.filter((r) => r[col] == null);
      else rows = rows.filter((r) => r[col] === val);
      return q;
    },
    not(col: string, op: string, val: any) {
      if (op === "is" && val === null) rows = rows.filter((r) => r[col] != null);
      return q;
    },
    or(expr: string) {
      const parts = expr
        .split(",")
        .map((p) => p.trim().match(/^(\w+)\.(\w+)\.(.*)$/))
        .filter(Boolean)
        .map((m) => ({ col: (m as RegExpMatchArray)[1], val: (m as RegExpMatchArray)[3] }));
      rows = rows.filter((r) => parts.some(({ col, val }) => String(r[col]) === val));
      return q;
    },
    maybeSingle() {
      return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null });
    },
    then(resolveFn: (v: any) => void, rejectFn?: (e: any) => void) {
      return Promise.resolve(result()).then(resolveFn, rejectFn);
    },
  };
  return q;
}

function makeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: USER } }, error: null }
          : token === TOKEN_RL
            ? { data: { user: { id: USER_RL } }, error: null }
            : { data: { user: null }, error: { message: "Unauthorized" } },
    },
    from: (table: string) => buildQuery(specOf(state, table)),
  };
}

/** The tables every gateway call touches, with the projection flag ON. */
function baseState(over: FakeState = {}): FakeState {
  return {
    feature_flags: PROJECTION_ON,
    blocks: [],
    protected_zones: [],
    places: [placeRow()],
    intel_live_promoted_scopes: [],
    intel_state_snapshots: [],
    ...over,
  };
}

// ── test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function get(path: string, token: string = TOKEN): Promise<{ status: number; body: any }> {
  return new Promise((resolveFn, rejectFn) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: "GET",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolveFn({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", rejectFn);
    r.end();
  });
}

/** A district-band viewport around RAW (individual objects, no aggregation). */
const DISTRICT = "bbox=108.15,16.00,108.25,16.10&zoom=13";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(mapProjectionRouter);
  await new Promise<void>((resolveFn) => {
    // Bind the loopback address explicitly: a host-less listen(0) binds [::]
    // and a foreign IPv4 listener can then answer the request.
    server = app.listen(0, "127.0.0.1", () => resolveFn());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  _clearProtectedZoneCache();
  _clearPromotedScopeCache();
  _resetRateLimit();
});

function serve(state: FakeState) {
  _setTestClient(makeClient(state) as any, true);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The projector's own contract (pure)
// ═════════════════════════════════════════════════════════════════════════════

describe("projectPlace — shape", () => {
  test("a canonical row becomes a place_level `place` at its own coordinate", () => {
    const obj = projectPlace(placeRow())!;
    assert.ok(obj, "an active row with a coordinate must project");
    assert.equal(obj.id, `place:${P1}`);
    assert.equal(obj.kind, "place");
    // GeoJSON order, and the SOURCE coordinate exactly — never rounded, never sharpened.
    assert.deepEqual(obj.geometry, { type: "Point", coordinates: [RAW.lng, RAW.lat] });
    assert.equal(obj.title, "Han Market");
    assert.equal(obj.subtitle, "night market · Hai Chau");
    assert.equal(obj.privacyClass, PLACE_PRIVACY_CLASS);
    assert.equal(obj.privacyClass, "place_level");
    assert.equal(obj.renderingPriority, KIND_DEFAULT_PRIORITY.place);
    assert.ok(isServable(obj));
  });

  test("the §8 sheet and the §25 rail are both reachable from the interaction config", () => {
    const obj = projectPlace(placeRow())!;
    assert.equal(obj.interaction?.opensSheet, true, "§8: a place opens the Live Place sheet");
    assert.equal(obj.interaction?.contributable, true, "§22: a place accepts observations");
    assert.equal(obj.interaction?.detailRoute, placeDetailRoute(P1));
    assert.equal(obj.interaction?.detailRoute, `/place/${P1}`);
    // §25's four persistent rail slots, plus §8's Save and Share.
    for (const a of ["ask_compass", "meet_here", "add_to_trip", "navigate", "save", "share", "view"]) {
      assert.ok(obj.interaction!.actions.includes(a as any), `place must offer ${a}`);
    }
  });

  test("the payload records the id bridge, and nothing else", () => {
    const obj = projectPlace(placeRow())!;
    assert.deepEqual(Object.keys(obj.payload as object).sort(), [
      "canonicalPlaceId",
      "category",
      "city",
      "countryCode",
      "discoveryId",
      "neighborhood",
    ]);
    const p = obj.payload as any;
    // The live-claim subject IS the row id (intel_state_snapshots.subject_id →
    // places.id), so the subject axis needs no bridge — and liveSubjectIdFor
    // must agree, or enrichment queries an id space the snapshot table never uses.
    assert.equal(p.canonicalPlaceId, P1);
    assert.equal(liveSubjectIdFor(obj), P1);
    // The Discovery-served id, `db/<places.id>` — the key the bookmark flow and
    // placeIdBridge accept. A bare uuid here would split one place into two saves.
    assert.equal(p.discoveryId, discoveryServedIdFor(P1));
    assert.equal(p.discoveryId, `db/${P1}`);
    assert.equal(p.countryCode, "VN");
    assert.equal(p.category, "night_market");
  });

  test("no coordinate copy survives in the payload — geometry is the one position §24 can coarsen", () => {
    const serialized = JSON.stringify(projectPlace(placeRow())!.payload);
    assert.ok(!serialized.includes(String(RAW.lat)), "payload must not carry latitude");
    assert.ok(!serialized.includes(String(RAW.lng)), "payload must not carry longitude");
  });

  test("subtitle degrades honestly: 'other' says nothing, city stands in for neighbourhood", () => {
    assert.equal(projectPlace(placeRow({ primary_category: "other" }))!.subtitle, "Hai Chau");
    assert.equal(
      projectPlace(placeRow({ primary_category: "other", neighborhood: null }))!.subtitle,
      "Da Nang",
    );
    assert.equal(
      projectPlace(placeRow({ primary_category: null, neighborhood: null, city: null }))!.subtitle,
      undefined,
    );
  });

  test("numeric strings are accepted as coordinates; anything non-finite is not", () => {
    const fromStrings = projectPlace(placeRow({ latitude: "16.05" as any, longitude: "108.2" as any }))!;
    assert.deepEqual(fromStrings.geometry.coordinates, [108.2, 16.05]);
    assert.equal(projectPlace(placeRow({ latitude: "not-a-number" as any })), null);
    assert.equal(projectPlace(placeRow({ longitude: Number.NaN })), null);
  });
});

describe("projectPlace — what must NOT become an object", () => {
  test("no coordinate, no object", () => {
    assert.equal(projectPlace(placeRow({ latitude: null })), null);
    assert.equal(projectPlace(placeRow({ longitude: undefined })), null);
  });

  test("a non-active or merged row is not a canonical fact about the world now", () => {
    for (const status of ["closed", "temporarily_closed", "moved", "duplicate", "unverified"]) {
      assert.equal(projectPlace(placeRow({ status })), null, `status=${status} must not project`);
    }
    assert.equal(projectPlace(placeRow({ merged_into_place_id: "some-other-id" })), null);
    // A row with no status field at all is not refused — the read filters on
    // status, and the projector only re-checks a value it was actually given.
    assert.ok(projectPlace(placeRow({ status: undefined })));
  });

  test("isServable is the last gate inside the producer: an unnamed row never leaves it", () => {
    assert.equal(projectPlace(placeRow({ name: "" })), null);
    assert.equal(projectPlace(placeRow({ name: "   " })), null);
    assert.equal(projectPlace(placeRow({ name: null })), null);
  });

  test("garbage in, null out — never a throw and never a default object", () => {
    assert.equal(projectPlace(null), null);
    assert.equal(projectPlace(undefined), null);
    assert.equal(projectPlace({} as any), null);
    assert.equal(projectPlace(placeRow({ id: "" })), null);
  });
});

describe("projectPlace — no invented intelligence (spec §37)", () => {
  test("a place row carries no freshness, confidence, activity, trend or provenance", () => {
    const obj = projectPlace(placeRow())!;
    for (const field of ["freshness", "confidence", "activity", "trend", "provenance", "sourceRefs", "sourceClass", "observedAt", "expiresAt", "count"]) {
      assert.equal((obj as any)[field], undefined, `${field} must be absent until a live claim supplies it`);
    }
  });
});

describe("projectPlace reads only columns the viewport query selects", () => {
  const selected = new Set(PLACE_SELECT_COLUMNS.split(",").map((c) => c.trim()));
  const source = readFileSync(resolve(__dir, "../lib/mapProjectPlace.ts"), "utf8");
  const fnStart = source.indexOf("export function projectPlace(");
  const fnEnd = source.indexOf("\n// ── The read", fnStart);
  const body = source.slice(fnStart, fnEnd);
  const reads = [...new Set([...body.matchAll(/\brow\.([a-z_]+)/g)].map((m) => m[1]))];

  test("the guard is reading real code, not an empty match", () => {
    assert.ok(fnStart >= 0 && fnEnd > fnStart, "could not locate projectPlace in the source");
    assert.ok(reads.length >= 8, `parsed only ${reads.length} row reads — the parse broke`);
    assert.ok(selected.size >= 8, "PLACE_SELECT_COLUMNS lost columns");
  });

  test("every `row.<column>` the projector reads is in PLACE_SELECT_COLUMNS", () => {
    for (const col of reads) {
      assert.ok(selected.has(col), `projectPlace reads row.${col}, which the viewport query never selects`);
    }
  });

  test("the founding defect of check:schema-references stays fixed: country_code, never country", () => {
    assert.ok(selected.has("country_code"));
    assert.ok(!selected.has("country"), "`places.country` does not exist — it has never existed");
    assert.ok(!reads.includes("country"));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. §7 axes are DERIVED from live claims, through the existing fold
// ═════════════════════════════════════════════════════════════════════════════

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

/** A claim envelope built by the production read-path shaper from a production-shaped claim. */
function claimFor(mapped: { claimType: string; value: unknown }, over: Partial<LiveClaim> = {}): LiveClaimLike {
  const claim: LiveClaim = {
    id: over.id ?? `snap-${mapped.claimType}`,
    claimType: mapped.claimType,
    value: mapped.value,
    confidence: CONFIDENCE_BAND_FLOOR.live + 0.05,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCount: 30,
    observedAt: new Date(NOW - 2 * 60_000).toISOString(),
    expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
    ...over,
  };
  return toLiveClaimEnvelope(claim);
}

describe("§7 axes on a projected place come from live claims, never from the row", () => {
  test("crowd.level and crowd.trajectory become Activity and Trend; freshness is deriveFreshness's answer", () => {
    const level = claimFor(mapQuickSignal("arrival", "busy")!);
    const trend = claimFor(mapQuickSignal("inside", "building")!);
    const obj = applyLiveClaims(projectPlace(placeRow())!, [level, trend], NOW);

    assert.equal(obj.activity, "busy");
    assert.equal(obj.trend, "getting_busier");
    assert.equal(obj.freshness, deriveFreshness(level.observedAt, level.validUntil, NOW));
    assert.equal(obj.freshness, "live");
    assert.equal(obj.confidence, "live");
    assert.equal(obj.observedAt, level.observedAt);
    assert.equal(obj.expiresAt, level.validUntil);
    // §9: one Why? line per claim, built by describeClaim from the coarse bucket.
    assert.equal(obj.provenance?.lines.length, 2);
    assert.match(obj.provenance!.lines[0].text, /^Several recent traveler reports · crowd\.level$/);
    assert.deepEqual(obj.sourceRefs, [level.id, trend.id]);
    // A place with qualifying live evidence is a §31 high-confidence live zone.
    assert.equal(obj.renderingPriority, RENDERING_PRIORITY.high_confidence_live_zone);
    // The identity half is untouched by enrichment.
    assert.equal(obj.id, `place:${P1}`);
    assert.equal(obj.privacyClass, "place_level");
  });

  test("an expired claim yields 'historical' and does not promote", () => {
    const stale = claimFor(mapQuickSignal("arrival", "busy")!, {
      observedAt: new Date(NOW - 3 * 3600_000).toISOString(),
      expiresAt: new Date(NOW - 60_000).toISOString(),
    });
    const obj = applyLiveClaims(projectPlace(placeRow())!, [stale], NOW);
    assert.equal(obj.freshness, "historical");
    assert.equal(obj.renderingPriority, KIND_DEFAULT_PRIORITY.place);
  });

  test("the reader is bounded and reports truncation instead of hiding it", async () => {
    const rows = placeCluster(3);
    const read = await loadViewportPlaceRows(
      makeClient({ places: rows }) as any,
      { west: 108, south: 16, east: 109, north: 17 },
      { max: 2 },
    );
    assert.ok(read);
    assert.equal(read!.rows.length, 2);
    assert.equal(read!.truncated, true);

    const whole = await loadViewportPlaceRows(makeClient({ places: rows }) as any, {
      west: 108, south: 16, east: 109, north: 17,
    });
    assert.equal(whole!.rows.length, 3);
    assert.equal(whole!.truncated, false);
    assert.ok(MAX_PLACE_ROWS >= 3);
  });

  test("a read failure is null — distinct from an empty viewport — and never throws", async () => {
    const failed = await loadViewportPlaceRows(
      makeClient({ places: { error: { message: "places down" } } }) as any,
      { west: 108, south: 16, east: 109, north: 17 },
    );
    assert.equal(failed, null);
    const empty = await loadViewportPlaceRows(makeClient({ places: [] }) as any, {
      west: 108, south: 16, east: 109, north: 17,
    });
    assert.deepEqual(empty, { rows: [], truncated: false });
    assert.equal(await loadViewportPlaceRows(null, { west: 0, south: 0, east: 1, north: 1 }), null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Through the gateway
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /map/projection?kinds=place", () => {
  it("serves a canonical place as a `place` object and names the layer in sources", async () => {
    serve(baseState());
    const { status, body } = await get(`/map/projection?${DISTRICT}&kinds=place`);
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
    assert.ok(body.sources.includes("places"), `sources: ${JSON.stringify(body.sources)}`);
    assert.deepEqual(body.places, { rows: 1, projected: 1, truncated: false });
    assert.equal(body.aggregation.band, "district");
    assert.equal(body.total, 1);

    const [obj] = body.objects as MapObject[];
    assert.equal(obj.id, `place:${P1}`);
    assert.equal(obj.kind, "place");
    assert.equal(obj.privacyClass, "place_level");
    assert.deepEqual(obj.geometry, { type: "Point", coordinates: [RAW.lng, RAW.lat] });
    assert.equal(obj.title, "Han Market");
    assert.equal(obj.interaction?.detailRoute, `/place/${P1}`);
    assert.equal(obj.interaction?.opensSheet, true);
    assert.equal((obj.payload as any).discoveryId, `db/${P1}`);
    // Ranked: distance from the viewport centre is attached.
    assert.equal(typeof obj.distanceKm, "number");
    // No live claim ⇒ no live axes. The row's own timestamps never become one.
    assert.equal(obj.freshness, undefined);
    assert.equal(obj.confidence, undefined);
    assert.equal(obj.activity, undefined);
    // It was CONSIDERED for enrichment (its subject is its own id) and found nothing.
    assert.deepEqual(body.liveEnrichment, { considered: 1, enriched: 0, skipped: 0 });
  });

  it("is collected when `kinds` is omitted, and NOT read when another kind is asked for", async () => {
    serve(baseState());
    const all = await get(`/map/projection?${DISTRICT}`);
    assert.ok(all.body.sources.includes("places"));
    assert.equal(all.body.objects.filter((o: MapObject) => o.kind === "place").length, 1);

    const events = await get(`/map/projection?${DISTRICT}&kinds=event`);
    assert.ok(!events.body.sources.includes("places"), "an unrequested layer must not be read");
    assert.equal(events.body.places, null);
    assert.equal(events.body.objects.filter((o: MapObject) => o.kind === "place").length, 0);
  });

  it("a live crowd claim keyed on places.id reaches the object as §7 axes and §9 lines", async () => {
    const nowMs = Date.now();
    const live = liveSnapshots(nowMs);
    serve(
      baseState({
        feature_flags: LIVE_LABELS_ON,
        intel_live_promoted_scopes: live.scopes,
        intel_state_snapshots: live.snapshots,
      }),
    );
    const { body } = await get(`/map/projection?${DISTRICT}&kinds=place`);
    assert.deepEqual(body.liveEnrichment, { considered: 1, enriched: 1, skipped: 0 });

    const [obj] = body.objects as MapObject[];
    assert.equal(obj.kind, "place");
    assert.equal(obj.activity, "busy", "§7 Activity from crowd.level");
    assert.equal(obj.trend, "getting_busier", "§7 Trend from crowd.trajectory");
    assert.equal(obj.freshness, "live", "§7 Freshness from deriveFreshness on the claim");
    assert.equal(obj.confidence, "live", "§7 Certainty is the claim's band");
    assert.equal(obj.sourceClass, "firsthand_unverified");
    assert.equal(obj.provenance?.lines.length, 2, "§9: one Why? line per claim");
    for (const line of obj.provenance!.lines) {
      assert.match(line.text, /traveler reports · crowd\./);
      assert.ok(line.ref?.startsWith("snap-"), "the ref is the snapshot id, never a contributor");
    }
    assert.ok(!JSON.stringify(body).includes('"source_count"'), "the raw cohort count never crosses the wire");
    assert.equal(obj.renderingPriority, RENDERING_PRIORITY.high_confidence_live_zone);
  });

  it("a place inside a private residence zone is SUPPRESSED before serialization (§24)", async () => {
    serve(baseState({ protected_zones: [zoneRow("private_residence")] }));
    const { body } = await get(`/map/projection?${DISTRICT}&kinds=place`);
    assert.equal(body.objects.length, 0);
    assert.equal(body.protection.suppressed, 1);
    assert.equal(body.protection.evaluated, 1);
    // The layer was READ (it is in sources) — protection is what withheld it.
    assert.ok(body.sources.includes("places"));
    assert.equal(body.places.projected, 1);
    const wire = JSON.stringify(body);
    assert.ok(!wire.includes(String(RAW.lat)), "the suppressed coordinate must not appear anywhere in the response");
    assert.ok(!wire.includes("Han Market"), "nor its name");
  });

  it("a place inside a medical facility zone is COARSENED: snapped to the zone anchor, axes stripped (§24)", async () => {
    const nowMs = Date.now();
    const live = liveSnapshots(nowMs);
    const zone = zoneRow("medical_facility");
    serve(
      baseState({
        feature_flags: LIVE_LABELS_ON,
        intel_live_promoted_scopes: live.scopes,
        intel_state_snapshots: live.snapshots,
        protected_zones: [zone],
      }),
    );
    const { body } = await get(`/map/projection?${DISTRICT}&kinds=place`);
    assert.equal(body.protection.coarsened, 1);
    assert.equal(body.objects.length, 1);
    const [obj] = body.objects as MapObject[];
    assert.equal(obj.kind, "place");
    assert.equal(obj.privacyClass, "approximate", "coarsened below place_level");
    // The anchor, to within 1e-7° (~1 cm): the server normalises longitude on
    // the way through, which moves the last float digit and nothing else.
    assert.equal(obj.geometry.type, "Point");
    const [servedLng, servedLat] = obj.geometry.coordinates as [number, number];
    assert.ok(Math.abs(servedLng - zone.center_lng) < 1e-7, `lng ${servedLng} is not the zone anchor ${zone.center_lng}`);
    assert.ok(Math.abs(servedLat - zone.center_lat) < 1e-7, `lat ${servedLat} is not the zone anchor ${zone.center_lat}`);
    assert.ok(Math.abs(servedLng - RAW.lng) > 1e-5 || Math.abs(servedLat - RAW.lat) > 1e-5, "the served position must not be the place itself");
    // Enrichment DID attach live axes (enriched: 1) — and §24 then stripped
    // every one of them, because "how busy is the clinic" is the disclosure.
    assert.equal(body.liveEnrichment.enriched, 1);
    for (const field of ["activity", "trend", "freshness", "sourceClass", "provenance", "sourceRefs", "observedAt", "expiresAt"]) {
      assert.equal((obj as any)[field], undefined, `${field} must be stripped inside a coarsen-class zone`);
    }
    assert.equal(obj.renderingPriority, KIND_DEFAULT_PRIORITY.place, "the live-zone promotion is reset");
    assert.ok(!JSON.stringify(body).includes(String(RAW.lat)), "the raw coordinate must not leak");
  });

  it("a non-servable row is dropped and the servable one still arrives", async () => {
    serve(baseState({ places: [placeRow(), placeRow({ id: "dddddddd-0000-0000-0000-0000000000p2", name: "" })] }));
    const { body } = await get(`/map/projection?${DISTRICT}&kinds=place`);
    assert.deepEqual(body.places, { rows: 2, projected: 1, truncated: false });
    assert.equal(body.total, 1);
    assert.equal(body.objects[0].id, `place:${P1}`);
  });

  it("a failed places read leaves the layer OUT of sources rather than serving an empty one", async () => {
    serve(baseState({ places: { error: { message: "places down" } } }));
    const { status, body } = await get(`/map/projection?${DISTRICT}&kinds=place`);
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
    assert.ok(!body.sources.includes("places"), "an unreadable layer must not claim to be empty");
    assert.equal(body.places, null);
    assert.equal(body.objects.length, 0);
  });

  it("honours the same paging as every other kind", async () => {
    serve(baseState({ places: placeCluster(3) }));
    const first = await get(`/map/projection?${DISTRICT}&kinds=place&limit=2`);
    assert.equal(first.body.total, 3);
    assert.equal(first.body.objects.length, 2);
    assert.equal(first.body.nextCursor, "2");

    const second = await get(`/map/projection?${DISTRICT}&kinds=place&limit=2&cursor=2`);
    assert.equal(second.body.objects.length, 1);
    assert.equal(second.body.nextCursor, null);

    const ids = new Set([...first.body.objects, ...second.body.objects].map((o: MapObject) => o.id));
    assert.equal(ids.size, 3, "the two pages partition the ranked list");
  });

  it("a capped viewport read is REPORTED as truncated, not served as the whole viewport", async () => {
    serve(baseState({ places: placeCluster(MAX_PLACE_ROWS + 1) }));
    const { body } = await get(`/map/projection?${DISTRICT}&kinds=place&limit=200`);
    assert.deepEqual(body.places, { rows: MAX_PLACE_ROWS, projected: MAX_PLACE_ROWS, truncated: true });
    assert.equal(body.total, MAX_PLACE_ROWS);
    assert.equal(body.objects.length, 200);
  });

  it("is subject to the gateway's rate limit like every other kind", async () => {
    serve(baseState());
    for (let i = 0; i < 60; i += 1) {
      const { status } = await get(`/map/projection?${DISTRICT}&kinds=place`, TOKEN_RL);
      assert.equal(status, 200, `request ${i + 1} should be within the limit`);
    }
    const { status, body } = await get(`/map/projection?${DISTRICT}&kinds=place`, TOKEN_RL);
    assert.equal(status, 429);
    assert.equal(body.error, "rate_limited");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. §31 — world and city bands aggregate, and the k floor holds
// ═════════════════════════════════════════════════════════════════════════════

describe("§31 viewport aggregation of places at wide zoom", () => {
  const WORLD = "bbox=100,10,120,20&zoom=3";
  const CITY = "bbox=108.0,16.0,108.5,16.2&zoom=9";

  test("the fixture cluster lands in ONE cell at both aggregating zooms — or the tests below prove nothing", () => {
    for (const zoom of [3, 9]) {
      const keys = new Set(
        placeCluster(MIN_ZONE_COHORT).map((r) => cellFor(Number(r.latitude), Number(r.longitude), zoom)!.key),
      );
      assert.equal(keys.size, 1, `zoom ${zoom}: cluster straddles ${keys.size} cells`);
    }
    assert.equal(zoomBandFor(3), "world");
    assert.equal(zoomBandFor(9), "city");
    assert.equal(zoomBandFor(13), "district");
  });

  for (const [label, viewport, band] of [
    ["world", WORLD, "world"],
    ["city", CITY, "city"],
  ] as const) {
    it(`${label} band: k places collapse into ONE activity_zone, and no individual pin is served`, async () => {
      serve(baseState({ places: placeCluster(MIN_ZONE_COHORT) }));
      const { body } = await get(`/map/projection?${viewport}&kinds=place`);
      assert.equal(body.aggregation.band, band);
      assert.equal(body.aggregation.zones, 1);
      assert.equal(body.aggregation.aggregated, MIN_ZONE_COHORT);
      assert.equal(body.aggregation.suppressedForKAnonymity, 0);

      const kinds = body.objects.map((o: MapObject) => o.kind);
      assert.deepEqual(kinds, ["activity_zone"], "§17: no POI pins at wide zoom");
      const [zone] = body.objects as MapObject[];
      assert.equal(zone.count, MIN_ZONE_COHORT);
      assert.equal(zone.title, `${MIN_ZONE_COHORT} places in this area`);
      assert.equal(zone.geometry.type, "Polygon");
      // An aggregate never carries a handle back onto its contributors.
      assert.equal(zone.sourceRefs, undefined);
      const wire = JSON.stringify(body.objects);
      assert.ok(!wire.includes("Place 1"), "no contributor name leaks through the zone");
      assert.ok(!wire.includes(`place:`), "no contributor id leaks through the zone");
    });

    it(`${label} band: k-1 places are SUPPRESSED, not drawn as a smaller zone`, async () => {
      serve(baseState({ places: placeCluster(MIN_ZONE_COHORT - 1) }));
      const { body } = await get(`/map/projection?${viewport}&kinds=place`);
      assert.equal(body.aggregation.band, band);
      assert.equal(body.objects.length, 0);
      assert.equal(body.aggregation.zones, 0);
      assert.equal(body.aggregation.suppressedForKAnonymity, MIN_ZONE_COHORT - 1);
      // The layer was read and projected; the k floor is what withheld it —
      // reported, so an empty world is never mistaken for a broken read.
      assert.ok(body.sources.includes("places"));
      assert.equal(body.places.projected, MIN_ZONE_COHORT - 1);
    });
  }

  it("district band serves the same cluster as individual places", async () => {
    serve(baseState({ places: placeCluster(MIN_ZONE_COHORT) }));
    const { body } = await get(`/map/projection?${DISTRICT}&kinds=place`);
    assert.equal(body.aggregation.band, "district");
    assert.equal(body.aggregation.individual, MIN_ZONE_COHORT);
    assert.equal(body.aggregation.zones, 0);
    assert.ok(body.objects.every((o: MapObject) => o.kind === "place"));
  });

  it("§24 runs BEFORE §31: a suppressed place never contributes to a cell's cohort", async () => {
    // Exactly k places, EXACTLY ONE of them inside a suppress-class zone: a 5 m
    // circle centred on Place 1, whose nearest neighbour on the fixture grid is
    // ~11 m away. If protection ran after aggregation the cell would publish
    // with count k; it must not — k-1 survivors are under the floor.
    serve(
      baseState({
        places: placeCluster(MIN_ZONE_COHORT),
        protected_zones: [
          zoneRow("private_residence", { center_lat: RAW.lat, center_lng: RAW.lng, radius_meters: 5 }),
        ],
      }),
    );
    const { body } = await get(`/map/projection?${WORLD}&kinds=place`);
    assert.equal(body.protection.suppressed, 1, "the zone must have caught exactly Place 1");
    assert.equal(body.places.projected, MIN_ZONE_COHORT, "all k rows projected — protection, not the producer, withheld one");
    assert.equal(body.aggregation.zones, 0, "the survivors are below k and must be withheld");
    assert.equal(body.aggregation.suppressedForKAnonymity, MIN_ZONE_COHORT - 1);
    assert.equal(body.objects.length, 0);
  });
});
