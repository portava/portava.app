/**
 * Sensing §7 on the Map, through the REAL HTTP routes — the three capability
 * flags migration 2350 seeds OFF, and what each one changes when it is ON.
 *
 * WHY THE OFF TESTS ARE THE LOAD-BEARING ONES
 * ===========================================
 * "Inert by default" is the hard constraint: with every 2350 flag off (or, as
 * in production, absent), GET /api/map/projection and
 * GET /api/map/projection/temporal must serve exactly what they served before
 * this work existed. The OFF tests assert the ABSENCE of every new field on
 * the wire while proving — through the §7 axes — that the fixture's live
 * claims really did flow, so an empty result cannot pass them by accident.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapSensingProjectionGates.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
  _clearCityZoneCache,
} from "../routes/mapProjection.js";
import temporalRouter from "../routes/mapProjectionTemporal.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import { KIND_DEFAULT_PRIORITY, RENDERING_PRIORITY, type MapObject } from "../lib/mapObjects.js";
import { MIN_ZONE_COHORT } from "../lib/mapAggregation.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const VIEWER = "77777777-aaaa-4aaa-8aaa-777777777777";
const TOKEN = "sensing-gates-token";
const NOW = Date.now();
const SPOT = { lat: 16.0678, lng: 108.2208 };
const BBOX_STR = "108.0,15.9,108.4,16.2";
const PLACE_ID = "88888888-bbbb-4bbb-8bbb-888888888888";

const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];

function snapshot(over: Record<string, unknown> = {}) {
  return {
    id: "snap-busy",
    subject_id: PLACE_ID,
    zone_id: null,
    claim_type: "crowd.level",
    value: { level: "busy" },
    confidence: 0.85,
    source_count: 30,
    observed_at: iso(-3),
    expires_at: iso(27),
    privacy_eligible: true,
    conflict_state: "none",
    source_class: "firsthand_unverified",
    computed_at: iso(-3),
    ...over,
  };
}

function placeRow(over: Record<string, unknown> = {}) {
  return {
    id: PLACE_ID,
    name: "Han Market",
    primary_category: "night_market",
    city: "Da Nang",
    neighborhood: "Hai Chau",
    country_code: "VN",
    latitude: SPOT.lat,
    longitude: SPOT.lng,
    status: "active",
    merged_into_place_id: null,
    ...over,
  };
}

/** A gateway world with one place carrying a busy + building live claim pair. */
function world(flags: { flag: string; enabled: boolean }[] = [], over: FakeState = {}): FakeState {
  return {
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }, ...LIVE_GATES_OPEN, ...flags],
    blocks: [],
    protected_zones: [],
    geo_zones: [],
    places: [placeRow()],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }, { scope_key: "|crowd.trajectory" }],
    intel_state_snapshots: [
      snapshot(),
      snapshot({ id: "snap-building", claim_type: "crowd.trajectory", value: { trajectory: "building" }, confidence: 0.8 }),
    ],
    ...over,
  };
}

const ON = (flag: string) => ({ flag, enabled: true });
const OFF = (flag: string) => ({ flag, enabled: false });

describe("Sensing §7 gates through GET /api/map/projection", () => {
  let app: ProjectionApp | null = null;

  beforeEach(() => {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
    _clearCityZoneCache();
    _clearPromotedScopeCache();
  });
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  async function serve(state: FakeState, query: string) {
    app = await startRouterApp(mapProjectionRouter, state, { token: TOKEN, userId: VIEWER });
    return app.projection(query);
  }

  const place = (body: any): MapObject => {
    const p = (body.objects as MapObject[]).find((o) => o.id === `place:${PLACE_ID}`);
    assert.ok(p, "the place must be served");
    return p as MapObject;
  };

  // ── OFF ─────────────────────────────────────────────────────────────────────

  it("every flag ABSENT (production's state): live claims flow, and not one new field reaches the wire", async () => {
    const r = await serve(world(), `bbox=${BBOX_STR}&zoom=14&kinds=place&mode=trip&intent=party`);
    assert.equal(r.status, 200);
    assert.equal(r.body.liveEnrichment.enriched, 1, "the fixture's claims must actually flow");
    const p = place(r.body);
    assert.equal(p.activity, "busy");
    assert.equal(p.trend, "getting_busier");
    assert.equal(p.renderingPriority, RENDERING_PRIORITY.high_confidence_live_zone);
    assert.equal("truthClass" in p, false);
    assert.equal("coverage" in p, false);
    assert.equal("experienceState" in (p.payload as object), false);
    assert.equal("safetyConstraint" in (p.payload as object), false);
    assert.equal(r.body.display, null);
    assert.equal(r.body.total, 1);
  });

  it("every flag seeded FALSE (2350 applied, nothing flipped): identical to absent", async () => {
    const flags = [OFF("map_experience_state_enabled"), OFF("map_world_moments_enabled"), OFF("map_display_resolver_enabled")];
    const a = await serve(world(), `bbox=${BBOX_STR}&zoom=14&kinds=place`);
    await app!.close(); app = null;
    const b = await serve(world(flags), `bbox=${BBOX_STR}&zoom=14&kinds=place`);
    const strip = (body: any) => ({ ...body, generatedAt: null });
    assert.deepEqual(strip(b.body), strip(a.body));
  });

  it("an UNREADABLE feature_flags table leaves the gateway itself off — fail-closed, upstream of every new switch", async () => {
    const r = await serve(world([], { feature_flags: { error: { message: "down" } } }), `bbox=${BBOX_STR}&zoom=14`);
    assert.equal(r.body.enabled, false);
    assert.deepEqual(r.body.objects, []);
    assert.equal(r.body.display, null);
  });

  // ── map_experience_state_enabled ────────────────────────────────────────────

  it("map_experience_state_enabled ON: the place carries truthClass, coverage and a §5.3 ExperienceState built from the same claims", async () => {
    const r = await serve(world([ON("map_experience_state_enabled")]), `bbox=${BBOX_STR}&zoom=14&kinds=place`);
    const p = place(r.body);
    assert.equal(p.truthClass, "corroborated", "30 independent reports ⇒ several ⇒ corroborated");
    assert.equal(p.coverage, "several");
    const s = (p.payload as any).experienceState;
    assert.equal(s.basis, "live_claims");
    assert.equal(s.crowd.density, "busy");
    assert.equal(s.crowd.momentum, "getting_busier");
    assert.deepEqual(s.dynamics, { heating_up: true, peaking: false, cooling: false, anomaly: null });
    assert.equal(s.vibe.energy, null);
    assert.deepEqual(s.truth, {
      truthClass: "corroborated", confidence: "live", coverage: "several", freshness: "live", provenance: "firsthand_unverified",
    });
    assert.deepEqual(s.claimRefs, p.sourceRefs);
    // The other two switches stayed off.
    assert.equal(r.body.display, null);
    assert.equal("safetyConstraint" in (p.payload as object), false);
  });

  it("map_experience_state_enabled ON but the pilot allowlist EMPTY (production): nothing to fold, nothing stamped", async () => {
    const r = await serve(world([ON("map_experience_state_enabled")], { intel_live_promoted_scopes: [] }), `bbox=${BBOX_STR}&zoom=14&kinds=place`);
    assert.equal(r.body.liveEnrichment.enriched, 0);
    const p = place(r.body);
    assert.equal("truthClass" in p, false);
    assert.equal("experienceState" in (p.payload as object), false);
  });

  // ── map_display_resolver_enabled ────────────────────────────────────────────

  it("map_display_resolver_enabled ON: a safety notice at the place strips its live promotion and marks it non-promotable; mode and intent are echoed", async () => {
    const withNotice = world([ON("map_display_resolver_enabled")], {
      intel_state_snapshots: [
        snapshot(),
        snapshot({ id: "snap-building", claim_type: "crowd.trajectory", value: { trajectory: "building" }, confidence: 0.8 }),
        snapshot({ id: "snap-unsafe", value: { level: "unsafe_density" }, confidence: 0.8 }),
      ],
    });
    const r = await serve(withNotice, `bbox=${BBOX_STR}&zoom=14&kinds=place,safety_notice&mode=trip&intent=party`);
    assert.equal(r.status, 200);
    const kinds = (r.body.objects as MapObject[]).map((o) => o.kind);
    assert.deepEqual(kinds, ["safety_notice", "place"]);
    const p = place(r.body);
    assert.equal(p.renderingPriority, KIND_DEFAULT_PRIORITY.place, "the high-confidence promotion is gone");
    assert.deepEqual((p.payload as any).safetyConstraint, { noticeRef: "safety:snap-unsafe", promotable: false });
    assert.deepEqual(r.body.display, {
      mode: "TRIP", intent: "party", band: "district", budget: 100, considered: 1, kept: 1,
      safetyNotices: 1, safetyConstrained: 1, droppedForBudget: 0, droppedByKind: {},
    });
    assert.equal(r.body.total, 2);
  });

  it("the SAME world with the resolver OFF: the promotion survives next to the notice (the defect the switch closes)", async () => {
    const withNotice = world([], {
      intel_state_snapshots: [snapshot(), snapshot({ id: "snap-unsafe", value: { level: "unsafe_density" }, confidence: 0.8 })],
    });
    const r = await serve(withNotice, `bbox=${BBOX_STR}&zoom=14&kinds=place,safety_notice`);
    const p = place(r.body);
    assert.equal(p.renderingPriority, RENDERING_PRIORITY.high_confidence_live_zone);
    assert.equal("safetyConstraint" in (p.payload as object), false);
    assert.equal(r.body.display, null);
  });

  it("map_display_resolver_enabled ON: the §17 band budget thins a crowded viewport and reports every drop by kind", async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      placeRow({ id: `${PLACE_ID.slice(0, -2)}${String(i).padStart(2, "0")}`, latitude: SPOT.lat + i * 0.0002 }),
    );
    // A world-band request over the same viewport: budget 40 at zoom 3 —
    // but places aggregate there, so use the street band with a tight limit
    // instead, where objects stay individual and the budget is min(limit, 160).
    const r = await serve(world([ON("map_display_resolver_enabled")], { places: rows, intel_state_snapshots: [] }), `bbox=${BBOX_STR}&zoom=16&kinds=place&limit=10`);
    assert.equal(r.body.display.budget, 10);
    assert.equal(r.body.display.kept, 10);
    assert.equal(r.body.display.droppedForBudget, 40);
    assert.deepEqual(r.body.display.droppedByKind, { place: 40 });
    assert.equal(r.body.total, 10);
    assert.equal(r.body.objects.length, 10);
    assert.equal(r.body.nextCursor, null, "what the budget dropped is never paged back in");
  });

  // ── map_world_moments_enabled ───────────────────────────────────────────────

  function pulseWorld(flags: { flag: string; enabled: boolean }[]): FakeState {
    // MIN_ZONE_COHORT places in one city-band cell aggregate into ONE
    // activity_zone that clears k, which the pulse producer accepts as a
    // people-bearing source: a real pulse, produced by the real pipeline.
    const rows = Array.from({ length: MIN_ZONE_COHORT }, (_, i) =>
      placeRow({ id: `${PLACE_ID.slice(0, -2)}${String(i).padStart(2, "0")}`, latitude: SPOT.lat + i * 0.0002 }),
    );
    return world([ON("map_world_intelligence_enabled"), ...flags], { places: rows, intel_state_snapshots: [] });
  }

  // The pulse grid is two zoom steps coarser than the request (5.625° cells at
  // zoom 8) and a contributor must sit INSIDE the request bbox by centroid, so
  // the city-band requests use a viewport wide enough to contain the cell.
  const WIDE_BBOX = "100.0,10.0,115.0,20.0";

  it("map_world_moments_enabled OFF: a pulse is exactly the pulse producer's object and the moments report is null", async () => {
    const r = await serve(pulseWorld([]), `bbox=${WIDE_BBOX}&zoom=8&kinds=place,world_pulse`);
    const pulses = (r.body.objects as MapObject[]).filter((o) => o.kind === "world_pulse");
    assert.equal(pulses.length, 1, "the fixture must yield a pulse");
    assert.equal("moment" in (pulses[0].payload as object), false);
    assert.equal("truthClass" in pulses[0], false);
    assert.equal("coverage" in pulses[0], false);
    assert.equal(r.body.worldIntelligence.worldMoments, null);
  });

  it("map_world_moments_enabled ON: the pulse carries `moment: null` (nothing changed), a truth class and coverage, and the report counts it", async () => {
    const r = await serve(pulseWorld([ON("map_world_moments_enabled")]), `bbox=${WIDE_BBOX}&zoom=8&kinds=place,world_pulse`);
    const pulses = (r.body.objects as MapObject[]).filter((o) => o.kind === "world_pulse");
    assert.equal(pulses.length, 1);
    assert.equal((pulses[0].payload as any).moment, null);
    assert.equal(pulses[0].truthClass, "observed");
    assert.equal(pulses[0].coverage, "few");
    assert.deepEqual(r.body.worldIntelligence.worldMoments, {
      considered: 1, attached: 0, unchanged: 1,
      byChange: { heating_up: 0, forming: 0, moving: 0, clearing: 0, unexpected_activity: 0, event_spillover: 0, traveler_surge: 0 },
    });
  });

  it("map_world_moments_enabled ON without map_world_intelligence_enabled: no pulses, so no moments and the layer refuses as flag_off", async () => {
    const r = await serve(world([ON("map_world_moments_enabled")]), `bbox=${BBOX_STR}&zoom=8&kinds=world_pulse`);
    assert.deepEqual(r.body.objects, []);
    assert.equal(r.body.worldIntelligence.refusal, "flag_off");
    assert.equal(r.body.worldIntelligence.worldMoments, null);
  });
});

// ── the temporal route ────────────────────────────────────────────────────────

describe("Sensing §7 SX-07 through GET /api/map/projection/temporal", () => {
  let app: ProjectionApp | null = null;
  const OTHER_HOST = "99999999-cccc-4ccc-8ccc-999999999999";
  const MIN = 60_000;

  beforeEach(() => { _clearProtectedZoneCache(); _clearFlowZoneCache(); });
  afterEach(async () => { if (app) await app.close(); app = null; });

  function eventWorld(flags: { flag: string; enabled: boolean }[]): FakeState {
    return {
      feature_flags: [{ flag: "map_projection_enabled", enabled: true }, ...flags],
      protected_zones: [],
      geo_zones: [],
      blocks: [],
      event_roles: [],
      events: [
        {
          id: "tm-ev-1", host_id: OTHER_HOST, title: "Rooftop set", location_name: "Sky Bar",
          location_lat: SPOT.lat, location_lng: SPOT.lng, show_exact_location: true,
          starts_at: new Date(NOW + 40 * MIN).toISOString(), ends_at: new Date(NOW + 100 * MIN).toISOString(),
          visibility: "public", state: "published", age_min: null, age_max: null, trust_score_min: null, verified_only: false,
        },
      ],
    };
  }

  async function temporal(state: FakeState, query: string): Promise<{ status: number; body: any }> {
    app = await startRouterApp(temporalRouter, state, { token: TOKEN, userId: VIEWER });
    const r = await fetch(`${app.baseUrl}/api/map/projection/temporal?${query}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return { status: r.status, body: (await r.json()) as any };
  }

  it("OFF: a forecast object has no truthClass (as before)", async () => {
    const r = await temporal(eventWorld([]), `bbox=${BBOX_STR}&offsetMinutes=60`);
    assert.equal(r.status, 200);
    const pred = (r.body.objects as MapObject[]).find((o) => o.id === "prediction:event:tm-ev-1");
    assert.ok(pred, "the forecast must be served");
    assert.equal("truthClass" in pred!, false);
  });

  it("map_experience_state_enabled ON: every forecast object is stamped `predicted`", async () => {
    const r = await temporal(eventWorld([ON("map_experience_state_enabled")]), `bbox=${BBOX_STR}&offsetMinutes=60`);
    const preds = (r.body.objects as MapObject[]).filter((o) => o.kind === "prediction");
    assert.ok(preds.length >= 1);
    for (const p of preds) assert.equal(p.truthClass, "predicted");
  });
});
