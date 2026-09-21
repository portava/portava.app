/**
 * safety_notice producer (Map spec §5 "Safety … always take[s] visual
 * precedence", §6 "Shield = Safety context", §24 "Safety and access warnings
 * take precedence over activity ranking", §31 Safety at the top of the ladder).
 *
 * THE SOURCE. No safety notice / alert table exists in the schema, and
 * `protected_zones` is the HIDE list (§24) — projecting its rows as notices
 * would publish, at top priority and exempt from the gate, exactly the
 * locations it withholds. The one server-owned safety claim is
 * `crowd.level = unsafe_density` (lib/intelContracts SPECIALIST_ONLY_CROWD_LEVELS),
 * unreachable from every contributor surface, written only by the projection
 * after specialist review; lib/mapProjection maps it to NO activity level and
 * records that "a real safety surface for it is owed". This is that surface.
 *
 * WHAT IS PINNED HERE
 *   privacy class      place_level — a public venue, not a person
 *   isServable         a projected notice clears the last gate before the wire
 *   §5 precedence      RENDERING_PRIORITY.safety, above every other tier;
 *                      never aggregated away; exempt from the §24 gate
 *   TTL                expires_at, from the snapshot; expired ⇒ null
 *   no presence        no count, no distinct_actors, no source_count — the
 *                      exemption rests on exactly that
 *   gates              the global live-label chain must be open; the
 *                      per-scope pilot allowlist is deliberately NOT applied
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapSafetyNoticeProducer.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
} from "../routes/mapProjection.js";
import { makeFakeMapDb, startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import {
  SAFETY_CLAIM_LEVEL,
  SAFETY_CLAIM_TYPE,
  SAFETY_NOTICE_PRIVACY_CLASS,
  isSafetyClaim,
  projectSafetyNotice,
  readSafetyNotices,
  type SafetyPlaceLike,
  type SafetySnapshotLike,
} from "../lib/mapProducers/safetyNoticeProducer.js";
import { SPECIALIST_ONLY_CROWD_LEVELS, confidenceBand } from "../lib/intelContracts.js";
import {
  KIND_DEFAULT_PRIORITY,
  RENDERING_PRIORITY,
  compareByRenderingPriority,
  isServable,
  type MapObject,
} from "../lib/mapObjects.js";
import {
  PROTECTION_EXEMPT_KINDS,
  applyProtection,
  type ProtectedZone,
} from "../lib/protectedLocations.js";
import { parseBbox } from "../lib/mapProjection.js";
import { NEVER_AGGREGATED_KINDS, type BBox } from "../lib/mapAggregation.js";
import { projectSavedPlace, resolveDiscoveryVenue } from "../lib/mapProducers/savedPlaceProducer.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const VIEWER = "55555555-eeee-4eee-8eee-555555555555";
const TOKEN = "safety-token";
// Anchored to the real clock: the gateway route ages notices against
// Date.now() (routes/mapProjection.ts nowMs), so a fixed past NOW would leave
// every gateway-served notice already expired. The pure projectSafetyNotice
// tests inject `now: NOW` and stay relative regardless. Same convention as the
// other gateway-integration suites (mapCrowdFlowLayer, mapProjectionLayers).
const NOW = Date.now();
const BBOX_STR = "108.0,15.9,108.4,16.2";
const BBOX: BBox = parseBbox(BBOX_STR) as BBox;
const PLACE_ID = "66666666-ffff-4fff-8fff-666666666666";
const SPOT = { lat: 16.0678, lng: 108.2208 };
const FAR = { lat: 10.7769, lng: 106.7009 };

function iso(offsetMinutes: number): string {
  return new Date(NOW + offsetMinutes * 60_000).toISOString();
}

/** An intel_state_snapshots row (2130) carrying the specialist-reviewed claim. */
function snapshot(over: Partial<SafetySnapshotLike> = {}): SafetySnapshotLike {
  return {
    id: "snap-1",
    subject_id: PLACE_ID,
    zone_id: null,
    claim_type: SAFETY_CLAIM_TYPE,
    value: { level: SAFETY_CLAIM_LEVEL },
    confidence: 0.85,
    observed_at: iso(-3),
    expires_at: iso(27),
    privacy_eligible: true,
    ...over,
  };
}

function place(over: Partial<SafetyPlaceLike> = {}): SafetyPlaceLike {
  return {
    id: PLACE_ID,
    name: "Han Market",
    city: "Da Nang",
    latitude: SPOT.lat,
    longitude: SPOT.lng,
    status: "active",
    merged_into_place_id: null,
    ...over,
  };
}

function notice(snapOver: Partial<SafetySnapshotLike> = {}, placeOver: Partial<SafetyPlaceLike> = {}): MapObject {
  const o = projectSafetyNotice(snapshot(snapOver), place(placeOver), { now: NOW });
  assert.ok(o, "expected a notice");
  return o as MapObject;
}

function zone(over: Partial<ProtectedZone> & { category: string }): ProtectedZone {
  return {
    id: "zone-1",
    shape: "circle",
    center: { lat: SPOT.lat, lng: SPOT.lng },
    radiusMeters: 400,
    ...over,
  } as ProtectedZone;
}

/** Every key, at any depth, of a serialized object. */
function deepKeys(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) { for (const x of v) deepKeys(x, out); return out; }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { out.add(k); deepKeys(x, out); }
  }
  return out;
}

// ── the claim ─────────────────────────────────────────────────────────────────

describe("the safety claim", () => {
  it("is the specialist-only crowd level and nothing else", () => {
    assert.deepEqual([...SPECIALIST_ONLY_CROWD_LEVELS], ["unsafe_density"]);
    assert.equal(SAFETY_CLAIM_LEVEL, "unsafe_density");
    assert.equal(SAFETY_CLAIM_TYPE, "crowd.level");
    assert.equal(isSafetyClaim(snapshot()), true);
    assert.equal(isSafetyClaim(snapshot({ value: "unsafe_density" })), true);
    assert.equal(isSafetyClaim(snapshot({ value: { level: "packed" } })), false);
    assert.equal(isSafetyClaim(snapshot({ claim_type: "crowd.trajectory" })), false);
    assert.equal(isSafetyClaim(null), false);
  });
});

// ── projectSafetyNotice — shape ───────────────────────────────────────────────

describe("projectSafetyNotice — shape", () => {
  it("is a safety_notice at the TOP of the §31 ladder, place_level, and servable", () => {
    const o = notice();
    assert.equal(o.id, "safety:snap-1");
    assert.equal(o.kind, "safety_notice");
    assert.equal(o.privacyClass, "place_level");
    assert.equal(o.privacyClass, SAFETY_NOTICE_PRIVACY_CLASS);
    assert.equal(o.renderingPriority, KIND_DEFAULT_PRIORITY.safety_notice);
    assert.equal(o.renderingPriority, RENDERING_PRIORITY.safety);
    assert.equal(isServable(o), true);
    assert.deepEqual(o.geometry, { type: "Point", coordinates: [SPOT.lng, SPOT.lat] });
    assert.equal(o.title, "Unsafe crowd density reported");
    assert.equal(o.subtitle, "Han Market · Da Nang");
  });

  it("§5: outranks every other kind's default tier", () => {
    for (const [kind, tier] of Object.entries(KIND_DEFAULT_PRIORITY)) {
      if (kind === "safety_notice") continue;
      assert.ok(RENDERING_PRIORITY.safety > tier, `${kind} (${tier}) must rank below safety`);
    }
  });

  it("§5: sorts ahead of a saved place at the same spot, however close either is", () => {
    const saved = projectSavedPlace(
      { key: "dp:dp-1" },
      resolveDiscoveryVenue({ id: "dp-1", name: "Han Market", lat: SPOT.lat, lng: SPOT.lng }),
    ) as MapObject;
    const s = notice();
    s.distanceKm = 5;
    saved.distanceKm = 0.1;
    assert.deepEqual([saved, s].sort(compareByRenderingPriority).map((o: MapObject) => o.kind), ["safety_notice", "saved_place"]);
  });

  it("is never aggregated away and is exempt from the §24 gate — by name", () => {
    assert.ok(NEVER_AGGREGATED_KINDS.includes("safety_notice"));
    assert.deepEqual([...PROTECTION_EXEMPT_KINDS], ["safety_notice"]);
  });

  it("carries the claim's own observation time, expiry, freshness and band (it IS an observation)", () => {
    const o = notice();
    assert.equal(o.observedAt, iso(-3));
    assert.equal(o.expiresAt, iso(27));
    assert.equal(o.freshness, "live");
    assert.equal(o.confidence, confidenceBand(0.85));
    assert.deepEqual(o.sourceRefs, ["snap-1"]);
    assert.equal(o.provenance?.confidence, confidenceBand(0.85));
    assert.match(o.provenance?.lines[0].text ?? "", /Specialist-reviewed/);
    // No speaker is invented.
    assert.equal(o.sourceClass, undefined);
  });

  it("carries NO presence payload: no count, no distinct_actors, no source_count, anywhere", () => {
    const keys = deepKeys(notice());
    for (const forbidden of ["count", "distinct_actors", "distinctActors", "source_count", "sourceCount", "cohortSize"]) {
      assert.ok(!keys.has(forbidden), `${forbidden} must not appear on a safety notice`);
    }
  });

  it("maps to no activity level — a crush is not 'Peak'", () => {
    assert.equal(notice().activity, undefined);
    assert.equal(notice().trend, undefined);
  });
});

// ── TTL and refusals ──────────────────────────────────────────────────────────

describe("projectSafetyNotice — TTL and what never renders", () => {
  it("an expired snapshot yields nothing, including at the exact expiry instant", () => {
    assert.equal(projectSafetyNotice(snapshot({ expires_at: iso(-1) }), place(), { now: NOW }), null);
    assert.equal(projectSafetyNotice(snapshot({ expires_at: new Date(NOW).toISOString() }), place(), { now: NOW }), null);
    assert.equal(projectSafetyNotice(snapshot({ expires_at: "garbage" }), place(), { now: NOW }), null);
  });

  it("freshness is derived from expiry and age, never asserted", () => {
    assert.equal(notice({ observed_at: iso(-20) }).freshness, "recent");
    // Past its policy TTL it would be 'historical' — but such a row is dropped entirely.
  });

  it("a non-safety claim, an ineligible snapshot, an inactive or merged place, or no coordinate ⇒ null", () => {
    assert.equal(projectSafetyNotice(snapshot({ value: { level: "packed" } }), place(), { now: NOW }), null);
    assert.equal(projectSafetyNotice(snapshot({ privacy_eligible: false }), place(), { now: NOW }), null);
    assert.equal(projectSafetyNotice(snapshot({ privacy_eligible: null }), place(), { now: NOW }), null);
    assert.equal(projectSafetyNotice(snapshot(), place({ status: "merged" }), { now: NOW }), null);
    assert.equal(projectSafetyNotice(snapshot(), place({ merged_into_place_id: "other" }), { now: NOW }), null);
    assert.equal(projectSafetyNotice(snapshot(), place({ latitude: null, longitude: null }), { now: NOW }), null);
    assert.equal(projectSafetyNotice(snapshot(), place({ latitude: 91 }), { now: NOW }), null);
  });
});

// ── §24 gate: precedence ──────────────────────────────────────────────────────

describe("safety_notice through the §24 gate", () => {
  it("SURVIVES inside a suppress-class zone (shelter), counted as safetyExempt, while a saved place there is withheld", () => {
    const saved = projectSavedPlace(
      { key: "dp:dp-1" },
      resolveDiscoveryVenue({ id: "dp-1", name: "Han Market", lat: SPOT.lat, lng: SPOT.lng }),
    ) as MapObject;
    const out = applyProtection([notice(), saved], [zone({ category: "shelter" })]);
    assert.deepEqual(out.objects.map((o: MapObject) => o.kind), ["safety_notice"]);
    assert.equal(out.report.safetyExempt, 1);
    assert.equal(out.report.suppressed, 1);
    // Untouched: still at the exact place, still current.
    assert.deepEqual(out.objects[0].geometry, { type: "Point", coordinates: [SPOT.lng, SPOT.lat] });
    assert.equal(out.objects[0].expiresAt, iso(27));
  });

  it("survives a coarsen-class zone uncoarsened", () => {
    const out = applyProtection([notice()], [zone({ category: "medical_facility" })]);
    assert.equal(out.objects.length, 1);
    assert.equal(out.report.safetyExempt, 1);
    assert.equal(out.report.coarsened, 0);
    assert.equal(out.objects[0].renderingPriority, RENDERING_PRIORITY.safety);
  });
});

// ── readSafetyNotices — gates ─────────────────────────────────────────────────

/** The global live-label chain, open. No kill switch row ⇒ not engaged. */
const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];

function world(over: FakeState = {}): FakeState {
  return {
    feature_flags: LIVE_GATES_OPEN,
    intel_state_snapshots: [snapshot()],
    places: [place()],
    // The per-scope pilot allowlist is EMPTY on purpose: it must not gate safety.
    intel_live_promoted_scopes: [],
    ...over,
  };
}

function client(state: FakeState) {
  return makeFakeMapDb(state, { token: TOKEN, userId: VIEWER });
}

describe("readSafetyNotices", () => {
  it("serves the notice when the global live gates are open — without a per-scope promotion", async () => {
    const r = await readSafetyNotices(client(world()), { bbox: BBOX, now: NOW });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.notices.length, 1);
    assert.equal(r.report.snapshots, 1);
    assert.equal(r.notices[0].kind, "safety_notice");
  });

  it("refuses when any link of the global live-label chain is closed, and does not read snapshots", async () => {
    for (const closed of LIVE_GATES_OPEN.map((f: { flag: string }) => f.flag)) {
      const flags = LIVE_GATES_OPEN.map((f: { flag: string; enabled: boolean }) =>
        f.flag === closed ? { ...f, enabled: false } : f,
      );
      const r = await readSafetyNotices(
        client(world({ feature_flags: flags, intel_state_snapshots: { error: { message: "must not be read" } } })),
        { bbox: BBOX, now: NOW },
      );
      assert.deepEqual(r, { ok: false, reason: "live_gates_closed" }, `expected refusal with ${closed} off`);
    }
  });

  it("refuses when the emergency stop is engaged", async () => {
    const r = await readSafetyNotices(
      client(world({ feature_flags: [...LIVE_GATES_OPEN, { flag: "disable_intel_live_labels", enabled: true }] })),
      { bbox: BBOX, now: NOW },
    );
    assert.deepEqual(r, { ok: false, reason: "live_gates_closed" });
  });

  it("an unreadable flag table engages the stop (fail-closed)", async () => {
    const r = await readSafetyNotices(
      client(world({ feature_flags: { error: { message: "down" } } })),
      { bbox: BBOX, now: NOW },
    );
    assert.deepEqual(r, { ok: false, reason: "live_gates_closed" });
  });

  it("a snapshot or place read failure is a refusal, not an empty layer", async () => {
    const a = await readSafetyNotices(
      client(world({ intel_state_snapshots: { error: { message: "down" } } })),
      { bbox: BBOX, now: NOW },
    );
    assert.deepEqual(a, { ok: false, reason: "snapshot_read_failed" });
    const b = await readSafetyNotices(client(world({ places: { error: { message: "down" } } })), { bbox: BBOX, now: NOW });
    assert.deepEqual(b, { ok: false, reason: "places_read_failed" });
  });

  it("only current, privacy-eligible unsafe_density snapshots are read", async () => {
    const r = await readSafetyNotices(
      client(
        world({
          intel_state_snapshots: [
            snapshot({ id: "expired", expires_at: iso(-1) }),
            snapshot({ id: "ineligible", privacy_eligible: false }),
            snapshot({ id: "busy", value: { level: "packed" } }),
            snapshot({ id: "current" }),
          ],
        }),
      ),
      { bbox: BBOX, now: NOW },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.report.snapshots, 1);
    assert.deepEqual(r.notices.map((n: MapObject) => n.id), ["safety:current"]);
  });

  it("a notice whose place is outside the viewport, inactive or merged is unplaced", async () => {
    const r = await readSafetyNotices(
      client(world({ places: [place({ latitude: FAR.lat, longitude: FAR.lng })] })),
      { bbox: BBOX, now: NOW },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.notices.length, 0);
    assert.equal(r.report.unplaced, 1);
  });
});

// ── through the gateway ───────────────────────────────────────────────────────

function gatewayWorld(over: FakeState = {}): FakeState {
  return world({
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }, ...LIVE_GATES_OPEN],
    blocks: [],
    protected_zones: [],
    // The saved layer reads the tables saves actually land in; `saved_places`
    // has no writers in production, so seeding it here would pin nothing.
    discovery_place_saves: [{ user_id: VIEWER, place_id: "dp-1", saved_at: iso(-1440) }],
    wishlist_places: [],
    discovery_places: [{ id: "dp-1", name: "Han Market", city: "Da Nang", neighborhood: null, primary_category: null, lat: SPOT.lat, lng: SPOT.lng, canonical_location_id: null }],
    ...over,
  });
}

describe("safety_notice through GET /api/map/projection", () => {
  let app: ProjectionApp | null = null;

  beforeEach(() => {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
  });
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  async function serve(state: FakeState, query: string) {
    app = await startRouterApp(mapProjectionRouter, state, { token: TOKEN, userId: VIEWER });
    return app.projection(query);
  }

  it("arrives at the top of the ranking, ahead of a saved place at the same spot", async () => {
    const r = await serve(gatewayWorld(), `bbox=${BBOX_STR}&zoom=14&kinds=safety_notice,saved_place`);
    assert.equal(r.status, 200);
    const kinds = (r.body.objects as MapObject[]).map((o: MapObject) => o.kind);
    assert.deepEqual(kinds, ["safety_notice", "saved_place"]);
    assert.ok(r.body.sources.includes("safety"));
    assert.deepEqual(r.body.producers.safety_notice, { refusal: null, collected: 1 });
    assert.equal(r.body.objects[0].renderingPriority, RENDERING_PRIORITY.safety);
  });

  it("§24 precedence end to end: inside a shelter zone the notice is served and the saved place is not", async () => {
    const r = await serve(
      gatewayWorld({
        protected_zones: [
          {
            id: "pz-1", category: "shelter", action: null, privacy_floor: null, shape: "circle",
            center_lat: SPOT.lat, center_lng: SPOT.lng, radius_meters: 400, ring: null,
            jurisdiction: null, policy_ref: null, active: true,
          },
        ],
      }),
      `bbox=${BBOX_STR}&zoom=14&kinds=safety_notice,saved_place`,
    );
    assert.deepEqual((r.body.objects as MapObject[]).map((o: MapObject) => o.kind), ["safety_notice"]);
    assert.equal(r.body.protection.safetyExempt, 1);
    assert.equal(r.body.protection.suppressed, 1);
  });

  it("is never folded into an activity zone at city zoom", async () => {
    const r = await serve(gatewayWorld(), `bbox=${BBOX_STR}&zoom=10&kinds=safety_notice`);
    assert.equal(r.body.objects.length, 1);
    assert.equal(r.body.objects[0].kind, "safety_notice");
  });

  it("live gates closed ⇒ the layer refuses in the envelope rather than reading as 'no danger here'", async () => {
    const r = await serve(
      gatewayWorld({ feature_flags: [{ flag: "map_projection_enabled", enabled: true }] }),
      `bbox=${BBOX_STR}&zoom=14&kinds=safety_notice`,
    );
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(r.body.producers.safety_notice, { refusal: "live_gates_closed", collected: 0 });
    assert.ok(!r.body.sources.includes("safety"));
  });
});
