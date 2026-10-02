/**
 * census-discovery §57 — A25, the Map half of Map §20 "Candidate relevance",
 * graded against the criteria the integrator set rather than the ones the
 * layer's first suite (mapDiscoveryCandidateConsumer.test.ts) chose.
 *
 * WHAT THIS FILE ADDS, AND WHY EACH PART
 * ======================================
 *  G. FLAGS-OFF IS A GOLDEN, NOT AN ABSENCE. The first suite proved "no
 *     `candidate` byte reaches the wire" with the gate shut. That is weaker than
 *     byte identity: a report field, an object order or a count could drift and
 *     it would still pass. G1 pins the WHOLE gate-shut body byte-for-byte, G2
 *     proves the gate-shut path reads NONE of Discovery's per-viewer tables
 *     (and is byte-identical when every one of them is broken), G3 proves that
 *     table list is not vacuous, and G4 proves the gate-open answer is the
 *     gate-shut answer plus annotations and nothing else.
 *  X. CROSS-VIEWER. A projection carries the REQUESTING viewer's relevance and
 *     no one else's: two viewers over one world, interleaved; every per-user
 *     filter the reader issued names the requester; and revocation both ways —
 *     a taste withdrawn is gone on the very next read, a taste granted appears
 *     on it, because nothing about a viewer is cached across requests. A place
 *     on the Map has no submitter at all (`public.places` is venue identity with
 *     no user column — lib/mapProjectPlace), so the only objects that DO carry
 *     a submitter (gem, event, trip stop, …) are exactly the kinds the layer
 *     refuses to annotate; X4 pins that refusal for every submitted kind.
 *  D. A FAILED DISCOVERY READ IS STATED, AND NEVER FAILS THE MAP. The reader
 *     cannot throw on a database error — every viewer read inside it is
 *     non-fatal by design — so the realistic failure is a DEGRADED read, and
 *     before §57 it was silent: `refusal: null` over a projection computed with
 *     no taste. D1/D2 go through the real route; D3/D4 pin the fold.
 *  R. RETRIES. The same request twice is the same body, healthy or degraded.
 *  S. A07 ON THE MAP. With Discovery's live rank ON and a Live unsafe reading,
 *     the Map candidate still carries no why-now (the Map reader never hands a
 *     grade in) and the Map's order is untouched by this layer — so no Map
 *     object is ever labelled "best move now" by Discovery.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/mapDiscoveryCandidateAdapter.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
  _clearCityZoneCache,
} from "../routes/mapProjection.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { makeFakeMapDb, mountRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import type { MapObject } from "../lib/mapObjects.js";
import { PLACE_PRIVACY_CLASS, discoveryServedIdFor } from "../lib/mapProjectPlace.js";
import {
  DISCOVERY_CANDIDATE_PROJECTION_FLAG,
  invalidateCandidateProjectionFlagCache,
  type CandidateReadOutcome,
  type DiscoveryCandidate,
} from "../lib/discoveryCandidate.js";
import { invalidateLiveRankFlagCache } from "../lib/discoveryLiveRankRead.js";
import {
  foldDiscoveryCandidates,
  refusedDiscoveryCandidates,
  selectDiscoveryCandidateRows,
  type MapDiscoveryPlaceRow,
} from "../lib/mapDiscoveryCandidates.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const VIEWER_A = "4c4c4c4c-1111-4111-8111-4c4c4c4c4c4c";
const VIEWER_B = "5d5d5d5d-2222-4222-8222-5d5d5d5d5d5d";
const TOKEN = "map-discovery-adapter-token";
const SPOT = { lat: 16.0678, lng: 108.2208 };
const QUERY = "bbox=108.0,15.9,108.4,16.2&zoom=14&kinds=place";
const PLACE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PLACE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

/**
 * The tables ONLY Discovery's reader reads on this route — measured, not
 * assumed: a recorder over the gate-open route sees these and the gate-shut
 * route does not (G2, G3). `protected_zones` and `feature_flags` are read by
 * the Map itself and are deliberately not on the list.
 */
const DISCOVERY_READER_TABLES = ["user_follows", "compass_user_preferences", "rank_events", "ranking_config"] as const;

/**
 * Per-user columns the reader filters on. Every value it sends in one of these
 * must be the requesting viewer's id (X2).
 */
const PER_USER_COLUMNS = new Set(["user_id", "follower_id", "viewer_id"]);

function placeRow(id: string, name: string) {
  return {
    id,
    name,
    primary_category: "night_market",
    city: "Da Nang",
    neighborhood: "Hai Chau",
    country_code: "VN",
    latitude: SPOT.lat,
    longitude: SPOT.lng,
    status: "active",
    merged_into_place_id: null,
  };
}

/** A taste the PDE ranker turns into `categoryAffinity` for night markets. */
function tasteFor(userId: string) {
  return { user_id: userId, interests: [], category_weights: { night_market: 5 } };
}

const ON = (flag: string) => ({ flag, enabled: true });
const OFF = (flag: string) => ({ flag, enabled: false });

function world(flags: { flag: string; enabled: boolean }[] = [], over: FakeState = {}): FakeState {
  return {
    feature_flags: [ON("map_projection_enabled"), ...flags],
    blocks: [],
    protected_zones: [],
    geo_zones: [],
    places: [placeRow(PLACE_A, "Han Market"), placeRow(PLACE_B, "Con Market")],
    intel_live_promoted_scopes: [],
    intel_state_snapshots: [],
    user_follows: [],
    compass_user_preferences: [tasteFor(VIEWER_A)],
    rank_events: [],
    ranking_config: [],
    ...over,
  };
}

/**
 * THE GATE-SHUT BODY, BYTE FOR BYTE (generatedAt nulled — it is a clock).
 * Captured from GET /api/map/projection over `world()` at this branch's base
 * (862ba541f), i.e. with the Map §20 layer present and Discovery's gate shut —
 * which is production's state. It is a literal on purpose: a change to what
 * the gate-shut Map serves has to be made HERE, in a reviewed diff, rather
 * than slip through an assertion that only checks for an absence.
 */
const GOLDEN_FLAGS_OFF = JSON.stringify({
  enabled: true,
  objects: [
    {
      id: `place:${PLACE_A}`, kind: "place",
      geometry: { type: "Point", coordinates: [108.2208, 16.0678] },
      title: "Han Market", subtitle: "night market · Hai Chau",
      privacyClass: "place_level", renderingPriority: 40,
      interaction: {
        actions: ["view", "save", "share", "navigate", "add_to_trip", "ask_compass", "meet_here", "report"],
        detailRoute: `/place/${PLACE_A}`, opensSheet: true, contributable: true,
      },
      payload: {
        category: "night_market", city: "Da Nang", neighborhood: "Hai Chau", countryCode: "VN",
        canonicalPlaceId: PLACE_A, discoveryId: `db/${PLACE_A}`,
      },
      distanceKm: 2.98,
    },
    {
      id: `place:${PLACE_B}`, kind: "place",
      geometry: { type: "Point", coordinates: [108.2208, 16.0678] },
      title: "Con Market", subtitle: "night market · Hai Chau",
      privacyClass: "place_level", renderingPriority: 40,
      interaction: {
        actions: ["view", "save", "share", "navigate", "add_to_trip", "ask_compass", "meet_here", "report"],
        detailRoute: `/place/${PLACE_B}`, opensSheet: true, contributable: true,
      },
      payload: {
        category: "night_market", city: "Da Nang", neighborhood: "Hai Chau", countryCode: "VN",
        canonicalPlaceId: PLACE_B, discoveryId: `db/${PLACE_B}`,
      },
      distanceKm: 2.98,
    },
  ],
  viewport: {
    bbox: { west: 108, south: 15.9, east: 108.4, north: 16.2 },
    zoom: 14, center: { lat: 16.05, lng: 108.2 }, radiusKm: 27.140728833223914,
  },
  total: 2,
  nextCursor: null,
  sources: ["places"],
  aggregation: { band: "district", cellSizeDegrees: null, aggregated: 0, individual: 2, dropped: 0, suppressedForKAnonymity: 0, zones: 0 },
  protection: { evaluated: 2, allowed: 2, coarsened: 0, suppressed: 0, safetyExempt: 0 },
  liveEnrichment: { considered: 2, enriched: 0, skipped: 0 },
  crowdFlow: null,
  producers: { meeting_point: null, memory: null, safety_notice: null, saved_place: null },
  places: { rows: 2, projected: 2, truncated: false },
  discoveryCandidates: {
    refusal: "flag_off", coverage: "nothing", servedPlaces: 2, eligible: 2, projected: 0,
    rankedBy: "none", suppressedWrites: 0,
  },
  trips: null,
  worldIntelligence: null,
  display: null,
  generatedAt: null,
});

// ── a recording client ────────────────────────────────────────────────────────

interface RecordedRead {
  table: string;
  filters: Array<[string, unknown]>;
}

/**
 * Wrap the fake so every `.from(table)` and every `.eq` / `.in` on it is
 * recorded. Reads only — the fake refuses writes itself, and the reader's
 * no-write client (lib/discoveryPde suppressWrites) sits ABOVE this proxy, so a
 * suppressed write never reaches it.
 */
function recording(client: any): { client: any; reads: RecordedRead[] } {
  const reads: RecordedRead[] = [];
  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => {
          const entry: RecordedRead = { table, filters: [] };
          reads.push(entry);
          const wrap = (builder: any): any =>
            new Proxy(builder, {
              get(bt, p) {
                const v = bt[p];
                if (typeof v !== "function") return v;
                if (p === "then") return v.bind(bt);
                return (...args: unknown[]) => {
                  if (p === "eq" || p === "in") entry.filters.push([String(args[0]), args[1]]);
                  const out = v.apply(bt, args);
                  return out === bt ? wrap(out) : out;
                };
              },
            });
          return wrap(target.from(table));
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { client: proxy, reads };
}

/** Strip the clock, so two bodies can be compared byte for byte. */
const unclocked = (body: any) => ({ ...body, generatedAt: null });

/** The body minus everything the Discovery layer adds — what G4 compares. */
function withoutDiscoveryLayer(body: any): any {
  const { discoveryCandidates: _dc, ...rest } = unclocked(body);
  return {
    ...rest,
    objects: (rest.objects as MapObject[]).map((o) => {
      const { candidate: _c, ...payload } = (o.payload ?? {}) as Record<string, unknown>;
      return { ...o, payload };
    }),
  };
}

const candidatesOf = (body: any): DiscoveryCandidate[] =>
  (body.objects as MapObject[])
    .filter((o) => o.kind === "place")
    .map((o) => (o.payload as any).candidate as DiscoveryCandidate);

// ─────────────────────────────────────────────────────────────────────────────

describe("§57 A25 — the Map consumes Discovery's candidate projection, graded", () => {
  let app: ProjectionApp | null = null;

  const reset = () => {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
    _clearCityZoneCache();
    _clearPromotedScopeCache();
    invalidateCandidateProjectionFlagCache();
    invalidateLiveRankFlagCache();
  };
  beforeEach(reset);
  afterEach(async () => {
    if (app) await app.close();
    app = null;
    reset();
  });

  /** One request as `viewer`, through the real gateway, over a recorder. */
  async function serve(state: FakeState, viewer: string = VIEWER_A, query: string = QUERY) {
    if (app) { await app.close(); app = null; }
    reset();
    const opts = { token: TOKEN, userId: viewer };
    const rec = recording(makeFakeMapDb(state, opts));
    app = await mountRouterApp(mapProjectionRouter, rec.client, opts);
    const r = await app.projection(query);
    return { status: r.status, body: r.body, reads: rec.reads };
  }

  // ── G. flags-off is a golden ─────────────────────────────────────────────

  describe("G. the gate-shut Map body is pinned byte for byte", () => {
    it("G1 flag ABSENT (production): the whole body serialises to the golden, byte for byte", async () => {
      const r = await serve(world());
      assert.equal(r.status, 200);
      assert.equal(JSON.stringify(unclocked(r.body)), GOLDEN_FLAGS_OFF);
    });

    it("G1b flag FALSE (migration 2361's seed): the same bytes", async () => {
      const r = await serve(world([OFF(DISCOVERY_CANDIDATE_PROJECTION_FLAG)]));
      assert.equal(JSON.stringify(unclocked(r.body)), GOLDEN_FLAGS_OFF);
    });

    it("G2 the gate-shut path reads NONE of Discovery's per-viewer tables — and is byte-identical when every one of them is broken", async () => {
      const broken: FakeState = {};
      for (const t of DISCOVERY_READER_TABLES) broken[t] = { error: { message: `${t} must not be read with the gate shut` } };
      const r = await serve(world([OFF(DISCOVERY_CANDIDATE_PROJECTION_FLAG)], broken));
      const touched = r.reads.map((x) => x.table).filter((t) => (DISCOVERY_READER_TABLES as readonly string[]).includes(t));
      assert.deepEqual(touched, [], `the gate-shut Map read Discovery's tables: ${touched.join(", ")}`);
      assert.equal(JSON.stringify(unclocked(r.body)), GOLDEN_FLAGS_OFF);
    });

    it("G3 the table list is not vacuous: with the gate OPEN the reader reads them, keyed on the viewer", async () => {
      const r = await serve(world([ON(DISCOVERY_CANDIDATE_PROJECTION_FLAG)]));
      const tables = new Set(r.reads.map((x) => x.table));
      for (const t of ["user_follows", "compass_user_preferences", "rank_events"]) {
        assert.ok(tables.has(t), `${t} was not read with the gate open — G2's absence would prove nothing`);
      }
    });

    it("G4 the gate-open answer IS the gate-shut answer plus annotations: nothing else moves, nothing else is added", async () => {
      const off = await serve(world([OFF(DISCOVERY_CANDIDATE_PROJECTION_FLAG)]));
      const on = await serve(world([ON(DISCOVERY_CANDIDATE_PROJECTION_FLAG)]));
      assert.equal(candidatesOf(on.body).filter(Boolean).length, 2, "the gate-open run must actually annotate");
      assert.equal(
        JSON.stringify(withoutDiscoveryLayer(on.body)),
        JSON.stringify(withoutDiscoveryLayer(off.body)),
        "the Discovery layer changed a byte of the Map it only annotates",
      );
    });
  });

  // ── X. cross-viewer ──────────────────────────────────────────────────────

  describe("X. a projection carries the requester's relevance and no one else's", () => {
    const flags = [ON(DISCOVERY_CANDIDATE_PROJECTION_FLAG)];

    it("X1 two viewers over one world, interleaved A · B · A: A's taste is A's alone, and A's answer does not drift", async () => {
      const a1 = await serve(world(flags), VIEWER_A);
      const b = await serve(world(flags), VIEWER_B);
      const a2 = await serve(world(flags), VIEWER_A);

      for (const c of candidatesOf(a1.body)) {
        assert.ok(c.whyForUser.includes("categoryAffinity"), `A's own taste is missing from ${c.id}`);
      }
      for (const c of candidatesOf(b.body)) {
        assert.equal(c.whyForUser.includes("categoryAffinity"), false, `B was served A's taste on ${c.id}`);
        assert.equal(c.reasons.some((r) => r.code === "saved_similar"), false, `B was told "because you saved similar places" on ${c.id}`);
      }
      assert.equal(
        JSON.stringify(unclocked(a2.body)),
        JSON.stringify(unclocked(a1.body)),
        "A's answer changed after B was served — something about a viewer outlived its request",
      );
    });

    it("X2 every per-user filter the reader issued names the REQUESTING viewer, and no other id", async () => {
      for (const viewer of [VIEWER_A, VIEWER_B]) {
        const r = await serve(world(flags), viewer);
        const perUser = r.reads.flatMap((x) => x.filters.filter(([col]) => PER_USER_COLUMNS.has(col)).map(([col, v]) => ({ table: x.table, col, v })));
        assert.ok(perUser.length >= 3, "the reader's per-user reads must be observed for this to mean anything");
        for (const f of perUser) {
          assert.equal(f.v, viewer, `${f.table}.${f.col} was filtered on ${String(f.v)} while ${viewer} asked`);
        }
      }
    });

    it("X3 revocation, A → withdrawn: the taste A removed is gone on A's very next read", async () => {
      const before = await serve(world(flags), VIEWER_A);
      assert.ok(candidatesOf(before.body).every((c) => c.whyForUser.includes("categoryAffinity")));
      const after = await serve(world(flags, { compass_user_preferences: [] }), VIEWER_A);
      for (const c of candidatesOf(after.body)) {
        assert.equal(c.whyForUser.includes("categoryAffinity"), false, `a withdrawn taste survived on ${c.id}`);
      }
    });

    it("X3b revocation, B → granted: a taste B adds appears on B's very next read", async () => {
      const before = await serve(world(flags), VIEWER_B);
      assert.ok(candidatesOf(before.body).every((c) => !c.whyForUser.includes("categoryAffinity")));
      const after = await serve(world(flags, { compass_user_preferences: [tasteFor(VIEWER_A), tasteFor(VIEWER_B)] }), VIEWER_B);
      for (const c of candidatesOf(after.body)) {
        assert.ok(c.whyForUser.includes("categoryAffinity"), `a granted taste did not reach ${c.id}`);
      }
    });

    it("X4 every kind that carries a submitter is refused, even when its payload names a Discovery id", () => {
      // A Map `place` is public venue identity with no user column. The kinds
      // below are the ones a PERSON stands behind (a gem's submitter, an
      // event's host, a trip's owner, a memory's author, a buddy, a crew
      // member). A private or blocked submitter's object is removed upstream
      // by the Map's own gates; this pins that even one that got through could
      // never be handed Discovery's relevance for another viewer.
      const submitted = ["hidden_gem", "event", "trip_stop", "memory", "buddy_zone", "crew_member", "saved_place", "meeting_point"] as const;
      for (const kind of submitted) {
        const obj = {
          id: `${kind}:1`, kind,
          geometry: { type: "Point", coordinates: [SPOT.lng, SPOT.lat] },
          title: "x", privacyClass: PLACE_PRIVACY_CLASS, renderingPriority: 50,
          payload: { discoveryId: discoveryServedIdFor(PLACE_A), canonicalPlaceId: PLACE_A, city: "Da Nang" },
        } as unknown as MapObject;
        const sel = selectDiscoveryCandidateRows([obj]);
        assert.equal(sel.rows.length, 0, `${kind} was offered to Discovery's reader`);
        assert.equal(sel.servedPlaces, 0, `${kind} was counted as a place`);
        const folded = foldDiscoveryCandidates([obj], sel, {
          candidates: [{ place: { id: discoveryServedIdFor(PLACE_A) } as MapDiscoveryPlaceRow, candidate: {} as DiscoveryCandidate }],
          rankedBy: "pde", suppressedWrites: 0, degraded: [],
        });
        assert.equal("candidate" in ((folded.objects[0].payload ?? {}) as object), false, `${kind} was annotated`);
      }
    });
  });

  // ── D. a failed Discovery read ──────────────────────────────────────────

  describe("D. a failed Discovery read is stated, and never fails the Map", () => {
    const flags = [ON(DISCOVERY_CANDIDATE_PROJECTION_FLAG)];

    it("D1 the viewer's preferences cannot be read: 200, every other layer untouched, and the report says so by name", async () => {
      const healthy = await serve(world(flags));
      const degraded = await serve(world(flags, { compass_user_preferences: { error: { message: "preferences down" } } }));

      assert.equal(degraded.status, 200);
      assert.equal(degraded.body.enabled, true, "a Discovery read failure must never blank the Map");
      const report = degraded.body.discoveryCandidates;
      assert.equal(report.refusal, "viewer_state_unreadable");
      assert.equal(report.coverage, "partial", "the projections present are real; an absent reason is not evidence of absence");
      assert.deepEqual(report.degraded, ["preferences"]);
      assert.equal(report.projected, 2, "degraded is not dropped — every place still carries its projection");
      for (const c of candidatesOf(degraded.body)) {
        assert.equal(c.whyForUser.includes("categoryAffinity"), false, "a taste that could not be read cannot be a reason");
      }
      assert.equal(
        JSON.stringify(withoutDiscoveryLayer(degraded.body)),
        JSON.stringify(withoutDiscoveryLayer(healthy.body)),
        "a failed Discovery read changed the Map outside the Discovery layer",
      );

      // The control: the healthy run says it was complete, with the key present and empty.
      assert.equal(healthy.body.discoveryCandidates.refusal, null);
      assert.deepEqual(healthy.body.discoveryCandidates.degraded, []);
    });

    it("D2 follows AND the seen set unreadable: both named, in the order they failed", async () => {
      const r = await serve(world(flags, {
        user_follows: { error: { message: "follows down" } },
        rank_events: { error: { message: "rank_events down" } },
      }));
      assert.equal(r.status, 200);
      assert.equal(r.body.discoveryCandidates.refusal, "viewer_state_unreadable");
      assert.deepEqual(r.body.discoveryCandidates.degraded, ["follows", "seen"]);
    });

    it("D3 the fold: a short answer stays `incomplete_projection` and still carries what degraded; `[]` is complete", () => {
      const page = [placeObj(PLACE_A), placeObj(PLACE_B)];
      const sel = selectDiscoveryCandidateRows(page);
      const one = outcome([PLACE_A], ["follows"]);
      const short = foldDiscoveryCandidates(page, sel, one).report;
      assert.equal(short.refusal, "incomplete_projection");
      assert.equal(short.coverage, "partial");
      assert.deepEqual(short.degraded, ["follows"]);

      const complete = foldDiscoveryCandidates(page, sel, outcome([PLACE_A, PLACE_B], [])).report;
      assert.equal(complete.refusal, null);
      assert.equal(complete.coverage, null);
      assert.deepEqual(complete.degraded, []);

      const allDegraded = foldDiscoveryCandidates(page, sel, outcome([PLACE_A, PLACE_B], ["preferences", "viewer_neighborhood"])).report;
      assert.equal(allDegraded.refusal, "viewer_state_unreadable");
      assert.equal(allDegraded.coverage, "partial");
      assert.deepEqual(allDegraded.degraded, ["preferences", "viewer_neighborhood"]);
    });

    it("D4 a refusal and a nothing-eligible answer read no viewer state, so they carry NO `degraded` key", () => {
      const page = [placeObj(PLACE_A)];
      const sel = selectDiscoveryCandidateRows(page);
      for (const r of [refusedDiscoveryCandidates("flag_off", sel), refusedDiscoveryCandidates("read_threw", sel)]) {
        assert.equal("degraded" in r, false, `${r.refusal} grew a degraded key — the gate-shut body would no longer be the golden`);
      }
      const threw = foldDiscoveryCandidates(page, sel, null).report;
      assert.equal("degraded" in threw, false);
      const nothing = foldDiscoveryCandidates([], selectDiscoveryCandidateRows([]), { candidates: [], rankedBy: "none", suppressedWrites: 0 }).report;
      assert.equal("degraded" in nothing, false);
      assert.equal(nothing.refusal, null);
    });
  });

  // ── R. retries ──────────────────────────────────────────────────────────

  describe("R. the same request twice is the same answer", () => {
    it("R1 healthy: byte-identical bodies", async () => {
      const w = world([ON(DISCOVERY_CANDIDATE_PROJECTION_FLAG)]);
      const one = await serve(w);
      const two = await serve(w);
      assert.equal(JSON.stringify(unclocked(two.body)), JSON.stringify(unclocked(one.body)));
    });

    it("R2 degraded: byte-identical bodies, the refusal included", async () => {
      const w = world([ON(DISCOVERY_CANDIDATE_PROJECTION_FLAG)], { compass_user_preferences: { error: { message: "down" } } });
      const one = await serve(w);
      const two = await serve(w);
      assert.equal(one.body.discoveryCandidates.refusal, "viewer_state_unreadable");
      assert.equal(JSON.stringify(unclocked(two.body)), JSON.stringify(unclocked(one.body)));
    });
  });

  // ── S. A07 on the Map ───────────────────────────────────────────────────

  describe("S. Sensing :129 on the Map surface — Discovery never labels a Map object 'best move now'", () => {
    const NOW = Date.now();
    const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();
    const LIVE_GATES_OPEN = [
      ON("intel_live_label_crowd"), ON("intel_claim_projection_crowd"),
      ON("intel_capture_quick_signal"), ON("intel_limited_live"),
    ];
    const unsafeSnapshot = {
      id: "snap-unsafe-a", subject_id: PLACE_A, zone_id: null, claim_type: "crowd.level",
      value: { level: "unsafe_density" }, confidence: 0.9, source_count: 30,
      observed_at: iso(-3), expires_at: iso(45), privacy_eligible: true, conflict_state: "none",
      source_class: "firsthand_unverified", computed_at: iso(-3),
    };

    it("S1 live rank ON, a Live unsafe_density on a place: no Map candidate carries a why-now, and the Map's order is its own", async () => {
      const live = (projection: boolean) => world(
        [...LIVE_GATES_OPEN, ON("discovery_live_rank_enabled"), projection ? ON(DISCOVERY_CANDIDATE_PROJECTION_FLAG) : OFF(DISCOVERY_CANDIDATE_PROJECTION_FLAG)],
        { intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }], intel_state_snapshots: [unsafeSnapshot] },
      );
      const off = await serve(live(false));
      const on = await serve(live(true));
      const cands = candidatesOf(on.body);
      assert.equal(cands.length, 2);
      for (const c of cands) {
        assert.equal(c.whyNow, null, `${c.id}: the Map reader hands no live grade in, so no why-now can be rendered`);
        assert.equal(c.whyNowValidForMs, null);
      }
      assert.deepEqual(
        (on.body.objects as MapObject[]).map((o) => o.id),
        (off.body.objects as MapObject[]).map((o) => o.id),
        "the Discovery layer re-ordered the Map",
      );
    });
  });
});

// ── pure helpers for D3 / D4 ─────────────────────────────────────────────────

function placeObj(id: string): MapObject {
  return {
    id: `place:${id}`,
    kind: "place",
    geometry: { type: "Point", coordinates: [SPOT.lng, SPOT.lat] },
    title: "x",
    privacyClass: PLACE_PRIVACY_CLASS,
    renderingPriority: 50,
    distanceKm: 1,
    payload: { category: "night_market", city: "Da Nang", canonicalPlaceId: id, discoveryId: discoveryServedIdFor(id) },
  } as MapObject;
}

function outcome(ids: string[], degraded: CandidateReadOutcome<MapDiscoveryPlaceRow>["degraded"]): CandidateReadOutcome<MapDiscoveryPlaceRow> {
  return {
    candidates: ids.map((id) => ({
      place: { id: discoveryServedIdFor(id) } as MapDiscoveryPlaceRow,
      candidate: { id: discoveryServedIdFor(id) } as DiscoveryCandidate,
    })),
    rankedBy: "pde",
    suppressedWrites: 0,
    degraded,
  };
}
