/**
 * saved_place producer (Map spec §16 "Saved" layer — on by default; §6 "Gold
 * marker = Saved / Passport / Memory"; §31 "Saved Place" tier; §28 "Cache saved
 * places"; §27 "Saved items").
 *
 * §18's thirteen kinds mapped the Saved layer to nothing, so the contract was
 * extended with `saved_place` on BOTH mirrors (src/test/mapObjectsContract.test.ts
 * holds them together). This suite pins the producer of that kind.
 *
 * WHAT IS PINNED HERE
 *   privacy class      place_level — a venue the viewer chose, shown to them
 *   isServable         a projected pin clears the last gate before the wire
 *   protection gate    coarsened in a coarsen-class zone, withheld in a
 *                      suppress-class zone (a place-like kind, not presence)
 *   TTL                none: a save is a preference, not a claim — no
 *                      expiresAt, no freshness, no confidence
 *   scope              the viewer's own rows only; the live-claim subject is
 *                      the canonical place, or nothing
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapSavedPlaceProducer.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
} from "../routes/mapProjection.js";
import { makeFakeMapDb, startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import {
  MAX_SAVED_PLACE_ROWS,
  SAVED_PLACE_PRIVACY_CLASS,
  projectSavedPlace,
  readSavedPlacePins,
  type SavedPlaceRowLike,
  type SavedPlaceVenueLike,
} from "../lib/mapProducers/savedPlaceProducer.js";
import {
  KIND_DEFAULT_PRIORITY,
  MAP_OBJECT_KINDS,
  RENDERING_PRIORITY,
  isServable,
  type MapObject,
} from "../lib/mapObjects.js";
import { applyProtection, type ProtectedZone } from "../lib/protectedLocations.js";
import { liveSubjectIdFor, parseBbox, parseKinds } from "../lib/mapProjection.js";
import type { BBox } from "../lib/mapAggregation.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const VIEWER = "77777777-1111-4111-8111-777777777777";
const OTHER = "88888888-2222-4222-8222-888888888888";
const TOKEN = "saved-token";
const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const BBOX_STR = "108.0,15.9,108.4,16.2";
const BBOX: BBox = parseBbox(BBOX_STR) as BBox;
const DP_ID = "dp-my-khe-cafe";
const CANONICAL = "99999999-3333-4333-8333-999999999999";
const SPOT = { lat: 16.0653, lng: 108.2455 };
const FAR = { lat: 10.7769, lng: 106.7009 };

function iso(offsetMinutes: number): string {
  return new Date(NOW + offsetMinutes * 60_000).toISOString();
}

function saved(over: Partial<SavedPlaceRowLike> & { user_id?: string } = {}): SavedPlaceRowLike & { user_id: string } {
  return { id: "sp-1", user_id: VIEWER, place_id: DP_ID, saved_at: iso(-1440), ...over };
}

function venue(over: Partial<SavedPlaceVenueLike> = {}): SavedPlaceVenueLike {
  return {
    id: DP_ID,
    name: "My Khe Cafe",
    city: "Da Nang",
    neighborhood: "My Khe",
    primary_category: "cafe",
    lat: SPOT.lat,
    lng: SPOT.lng,
    canonical_location_id: CANONICAL,
    ...over,
  };
}

function pin(savedOver: Partial<SavedPlaceRowLike> = {}, venueOver: Partial<SavedPlaceVenueLike> = {}): MapObject {
  const o = projectSavedPlace(saved(savedOver), venue(venueOver));
  assert.ok(o, "expected a pin");
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

// ── contract ──────────────────────────────────────────────────────────────────

describe("the saved_place kind is part of the contract", () => {
  it("is declared, parseable from kinds=, and sits on the §31 Saved Place tier", () => {
    assert.ok(MAP_OBJECT_KINDS.includes("saved_place"));
    assert.deepEqual(parseKinds("saved_place"), ["saved_place"]);
    assert.equal(KIND_DEFAULT_PRIORITY.saved_place, RENDERING_PRIORITY.saved_place);
    assert.ok(RENDERING_PRIORITY.saved_place < RENDERING_PRIORITY.social_opportunity);
    assert.ok(RENDERING_PRIORITY.saved_place > RENDERING_PRIORITY.generic_poi);
  });
});

// ── projectSavedPlace ─────────────────────────────────────────────────────────

describe("projectSavedPlace — shape", () => {
  it("is a saved_place at the saved-place tier, place_level, and servable", () => {
    const o = pin();
    assert.equal(o.id, "saved:sp-1");
    assert.equal(o.kind, "saved_place");
    assert.equal(o.privacyClass, "place_level");
    assert.equal(o.privacyClass, SAVED_PLACE_PRIVACY_CLASS);
    assert.equal(o.renderingPriority, RENDERING_PRIORITY.saved_place);
    assert.equal(isServable(o), true);
    assert.deepEqual(o.geometry, { type: "Point", coordinates: [SPOT.lng, SPOT.lat] });
    assert.equal(o.title, "My Khe Cafe");
    assert.equal(o.subtitle, "cafe · My Khe");
    assert.equal(o.interaction?.detailRoute, `/place/${encodeURIComponent("db/" + DP_ID)}`);
    assert.equal(o.interaction?.contributable, true);
  });

  it("no TTL: a save is a preference, not an observation — no expiresAt, freshness or confidence", () => {
    const o = pin();
    assert.equal(o.expiresAt, undefined);
    assert.equal(o.observedAt, undefined);
    assert.equal(o.freshness, undefined);
    assert.equal(o.confidence, undefined);
    assert.equal(o.activity, undefined);
    assert.equal(o.trend, undefined);
  });

  it("its live-claim subject is the CANONICAL place (2053 bridge), or nothing — never the discovery id", () => {
    assert.equal(liveSubjectIdFor(pin()), CANONICAL);
    assert.equal(liveSubjectIdFor(pin({}, { canonical_location_id: null })), null);
    assert.equal((pin().payload as { canonicalPlaceId: string | null }).canonicalPlaceId, CANONICAL);
  });

  it("refuses a venue that is not the saved place's venue, or one it cannot draw", () => {
    assert.equal(projectSavedPlace(saved(), venue({ id: "someone-elses-venue" })), null);
    assert.equal(projectSavedPlace(saved(), venue({ lat: null, lng: null })), null);
    assert.equal(projectSavedPlace(saved(), venue({ lat: 91 })), null);
    assert.equal(projectSavedPlace(saved({ id: "" }), venue()), null);
  });

  it("falls back to a generic title rather than serving an empty one", () => {
    assert.equal(pin({}, { name: "  " }).title, "Saved place");
    assert.equal(pin({}, { primary_category: null, neighborhood: null }).subtitle, "Da Nang");
  });
});

// ── §24 protection gate ───────────────────────────────────────────────────────

describe("saved_place through the §24 gate", () => {
  it("is coarsened (not suppressed) inside a coarsen-class zone", () => {
    const hospital = zone({ category: "medical_facility", center: { lat: SPOT.lat + 0.001, lng: SPOT.lng } });
    const out = applyProtection([pin()], [hospital]);
    assert.equal(out.objects.length, 1);
    assert.equal(out.report.coarsened, 1);
    assert.equal(out.report.suppressed, 0);
    assert.notDeepEqual(out.objects[0].geometry, { type: "Point", coordinates: [SPOT.lng, SPOT.lat] });
  });

  it("is withheld inside a suppress-class zone", () => {
    const out = applyProtection([pin()], [zone({ category: "private_residence" })]);
    assert.equal(out.objects.length, 0);
    assert.equal(out.report.suppressed, 1);
  });

  it("passes untouched when no zone covers it", () => {
    const out = applyProtection([pin()], [zone({ category: "shelter", center: FAR })]);
    assert.equal(out.objects.length, 1);
    assert.equal(out.report.allowed, 1);
  });
});

// ── readSavedPlacePins ────────────────────────────────────────────────────────

function world(over: FakeState = {}): FakeState {
  return {
    saved_places: [saved(), saved({ id: "sp-other", user_id: OTHER, place_id: DP_ID })],
    discovery_places: [venue()],
    ...over,
  };
}

function client(state: FakeState) {
  return makeFakeMapDb(state, { token: TOKEN, userId: VIEWER });
}

describe("readSavedPlacePins — the viewer's own wishlist", () => {
  it("reads only the viewer's rows", async () => {
    const r = await readSavedPlacePins(client(world()), VIEWER, { bbox: BBOX });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.report.saved, 1);
    assert.deepEqual(r.pins.map((p: MapObject) => p.id), ["saved:sp-1"]);
    const serialized = JSON.stringify(r.pins);
    assert.ok(!serialized.includes("sp-other"), "another user's save reached the viewer");
    assert.ok(!serialized.includes(OTHER));
  });

  it("is viewport-scoped on the venue coordinate", async () => {
    const r = await readSavedPlacePins(
      client(world({ discovery_places: [venue({ lat: FAR.lat, lng: FAR.lng })] })),
      VIEWER,
      { bbox: BBOX },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.pins.length, 0);
    assert.equal(r.report.unplaced, 1);
  });

  it("read failures are refusals, not empty layers", async () => {
    const a = await readSavedPlacePins(client(world({ saved_places: { error: { message: "down" } } })), VIEWER, { bbox: BBOX });
    assert.deepEqual(a, { ok: false, reason: "saved_read_failed" });
    const b = await readSavedPlacePins(client(world({ discovery_places: { error: { message: "down" } } })), VIEWER, { bbox: BBOX });
    assert.deepEqual(b, { ok: false, reason: "places_read_failed" });
  });

  it("reports the cap when the wishlist is longer than the read", async () => {
    const rows = Array.from({ length: MAX_SAVED_PLACE_ROWS + 1 }, (_v: unknown, i: number) =>
      saved({ id: `sp-${i}`, place_id: `dp-${i}` }),
    );
    const r = await readSavedPlacePins(client(world({ saved_places: rows, discovery_places: [] })), VIEWER, { bbox: BBOX });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.report.saved, MAX_SAVED_PLACE_ROWS);
    assert.equal(r.report.capped, true);
  });
});

// ── through the gateway ───────────────────────────────────────────────────────

function gatewayWorld(over: FakeState = {}): FakeState {
  return world({
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }],
    blocks: [],
    protected_zones: [],
    ...over,
  });
}

describe("saved_place through GET /api/map/projection", () => {
  let app: ProjectionApp | null = null;

  beforeEach(() => {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
  });
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  async function serve(state: FakeState, userId: string, query: string) {
    app = await startRouterApp(mapProjectionRouter, state, { token: TOKEN, userId });
    return app.projection(query);
  }

  it("arrives as the viewer's gold pin, place_level, and reports its layer", async () => {
    const r = await serve(gatewayWorld(), VIEWER, `bbox=${BBOX_STR}&zoom=14&kinds=saved_place`);
    assert.equal(r.status, 200);
    const objs = r.body.objects as MapObject[];
    assert.equal(objs.length, 1);
    assert.equal(objs[0].kind, "saved_place");
    assert.equal(objs[0].id, "saved:sp-1");
    assert.equal(objs[0].privacyClass, "place_level");
    assert.equal(objs[0].renderingPriority, RENDERING_PRIORITY.saved_place);
    assert.ok(r.body.sources.includes("saved"));
    assert.deepEqual(r.body.producers.saved_place, { refusal: null, collected: 1 });
    // The kind filter round-trips through parseKinds/filterKinds.
    assert.ok(!JSON.stringify(r.body).includes("sp-other"));
  });

  it("another viewer sees their own list, not this one", async () => {
    const r = await serve(gatewayWorld(), OTHER, `bbox=${BBOX_STR}&zoom=14&kinds=saved_place`);
    assert.deepEqual((r.body.objects as MapObject[]).map((o: MapObject) => o.id), ["saved:sp-other"]);
  });

  it("is not read when the kind is not requested", async () => {
    const r = await serve(gatewayWorld(), VIEWER, `bbox=${BBOX_STR}&zoom=14&kinds=hidden_gem`);
    assert.equal(r.body.producers.saved_place, null);
    assert.ok(!r.body.sources.includes("saved"));
  });

  it("a read failure is a refusal in the envelope", async () => {
    const r = await serve(
      gatewayWorld({ saved_places: { error: { message: "down" } } }),
      VIEWER,
      `bbox=${BBOX_STR}&zoom=14&kinds=saved_place`,
    );
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(r.body.producers.saved_place, { refusal: "saved_read_failed", collected: 0 });
  });

  it("is withheld by the §24 gate inside a suppress-class zone", async () => {
    const r = await serve(
      gatewayWorld({
        protected_zones: [
          {
            id: "pz-1", category: "private_residence", action: null, privacy_floor: null, shape: "circle",
            center_lat: SPOT.lat, center_lng: SPOT.lng, radius_meters: 400, ring: null,
            jurisdiction: null, policy_ref: null, active: true,
          },
        ],
      }),
      VIEWER,
      `bbox=${BBOX_STR}&zoom=14&kinds=saved_place`,
    );
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(r.body.producers.saved_place, { refusal: null, collected: 1 });
    assert.equal(r.body.protection.suppressed, 1);
  });
});
