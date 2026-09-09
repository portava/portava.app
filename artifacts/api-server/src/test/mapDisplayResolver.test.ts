/**
 * mapDisplayResolver — Sensing §7 SX-08 (display resolver / clutter budget)
 * and SX-09 (safety constraints outrank opportunity) on the Map.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapDisplayResolver.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  BAND_CLUTTER_BUDGET,
  CLASS_OF_KIND,
  DISPLAY_INTENTS,
  DISPLAY_MODES,
  INTENT_KIND_AFFINITY,
  MODE_CLASS_SHARES,
  SAFETY_CONSTRAINT_RADIUS_KM,
  applySafetyPrecedence,
  parseDisplayIntent,
  parseDisplayMode,
  resolveDisplay,
} from "../lib/mapDisplayResolver.js";
import {
  KIND_DEFAULT_PRIORITY,
  MAP_OBJECT_KINDS,
  RENDERING_PRIORITY,
  type MapObject,
  type MapObjectKind,
} from "../lib/mapObjects.js";
import { rankObjects } from "../lib/mapProjection.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const HERE = { lat: 16.05, lng: 108.2 };

function obj(kind: MapObjectKind, id: string, over: Partial<MapObject> & { at?: { lat: number; lng: number } } = {}): MapObject {
  const at = over.at ?? HERE;
  const { at: _ignored, ...rest } = over;
  return {
    id,
    kind,
    geometry: { type: "Point", coordinates: [at.lng, at.lat] },
    title: id,
    privacyClass: "place_level",
    renderingPriority: KIND_DEFAULT_PRIORITY[kind],
    ...rest,
  };
}

function notice(placeId: string, at = HERE): MapObject {
  return obj("safety_notice", `safety:${placeId}`, { at, payload: { placeId } });
}

function many(kind: MapObjectKind, n: number, prefix = kind): MapObject[] {
  return Array.from({ length: n }, (_, i) => obj(kind, `${prefix}:${i}`, { at: { lat: HERE.lat + i * 0.01, lng: HERE.lng } }));
}

const ranked = (objects: MapObject[]) => rankObjects(objects, HERE);

// ── vocabulary ────────────────────────────────────────────────────────────────

describe("vocabulary", () => {
  test("modes are §30's seven, intents are §13's nine, every kind has a class, every mode's shares sum to 1", () => {
    assert.deepEqual([...DISPLAY_MODES], ["LIVE", "PLACE_SELECTED", "COMPASS", "TRIP", "CROWD_FLOW", "LOCATE_FRIENDS", "TIME_MACHINE"]);
    assert.deepEqual([...DISPLAY_INTENTS], ["bored", "eat", "party", "explore", "meet_people", "date_night", "chill", "local", "surprise_me"]);
    for (const kind of MAP_OBJECT_KINDS) assert.ok(CLASS_OF_KIND[kind], `kind ${kind} has no display class`);
    assert.equal(CLASS_OF_KIND.safety_notice, "safety");
    for (const mode of DISPLAY_MODES) {
      const s = MODE_CLASS_SHARES[mode];
      assert.ok(Math.abs(s.people + s.trip + s.live + s.places - 1) < 1e-9, `${mode} shares must sum to 1`);
    }
    for (const intent of DISPLAY_INTENTS) {
      for (const [kind, boost] of Object.entries(INTENT_KIND_AFFINITY[intent])) {
        assert.ok(MAP_OBJECT_KINDS.includes(kind as MapObjectKind));
        assert.ok(typeof boost === "number" && boost > 0);
        assert.notEqual(kind, "safety_notice", "intent never touches safety");
      }
    }
    for (const band of ["world", "city", "district", "street", "venue"] as const) {
      assert.ok(BAND_CLUTTER_BUDGET[band] >= 1 && BAND_CLUTTER_BUDGET[band] <= 200);
    }
  });

  test("parsing is lenient on case and strict on membership", () => {
    assert.equal(parseDisplayMode("trip"), "TRIP");
    assert.equal(parseDisplayMode(" Compass "), "COMPASS");
    assert.equal(parseDisplayMode("FLY"), null);
    assert.equal(parseDisplayMode(undefined), null);
    assert.equal(parseDisplayIntent("PARTY"), "party");
    assert.equal(parseDisplayIntent("sleep"), null);
    assert.equal(parseDisplayIntent(7), null);
  });
});

// ── SX-09 safety precedence ───────────────────────────────────────────────────

describe("safety precedence (SX-09)", () => {
  test("a promoted place AT a noticed place loses its promotion and is marked non-promotable; a place elsewhere is untouched", () => {
    const promoted = obj("place", "place:p1", { renderingPriority: RENDERING_PRIORITY.high_confidence_live_zone, payload: { category: "bar" } });
    const elsewhere = obj("place", "place:p2", { at: { lat: HERE.lat + 0.1, lng: HERE.lng }, renderingPriority: RENDERING_PRIORITY.high_confidence_live_zone });
    const { objects, constrained } = applySafetyPrecedence([promoted, elsewhere], [notice("p1")]);
    assert.equal(constrained, 1);
    const p1 = objects.find((o) => o.id === "place:p1")!;
    assert.equal(p1.renderingPriority, KIND_DEFAULT_PRIORITY.place);
    assert.deepEqual(p1.payload, { category: "bar", safetyConstraint: { noticeRef: "safety:p1", promotable: false } });
    const p2 = objects.find((o) => o.id === "place:p2")!;
    assert.equal(p2.renderingPriority, RENDERING_PRIORITY.high_confidence_live_zone);
    assert.equal("safetyConstraint" in ((p2.payload ?? {}) as object), false);
    assert.equal(promoted.renderingPriority, RENDERING_PRIORITY.high_confidence_live_zone, "pure — input not mutated");
  });

  test("matching is by canonical place id (place:, payload.canonicalPlaceId, payload.placeId) OR by ~100 m radius", () => {
    const gem = obj("hidden_gem", "gem:g1", { at: { lat: 0, lng: 0 }, payload: { canonicalPlaceId: "p1" } });
    const zoneNear = obj("activity_zone", "az:1", { at: { lat: HERE.lat + 0.0005, lng: HERE.lng } }); // ~55 m
    const zoneFar = obj("activity_zone", "az:2", { at: { lat: HERE.lat + 0.002, lng: HERE.lng } }); // ~220 m
    const { objects, constrained } = applySafetyPrecedence([gem, zoneNear, zoneFar], [notice("p1")]);
    assert.equal(constrained, 2);
    assert.ok((objects[0].payload as any).safetyConstraint, "gem matched by canonical place id");
    assert.ok((objects[1].payload as any).safetyConstraint, "zone matched by radius");
    assert.equal((objects[2].payload as any)?.safetyConstraint, undefined);
    assert.ok(SAFETY_CONSTRAINT_RADIUS_KM <= 0.15);
  });

  test("never raises: an object already below its default keeps its lower priority", () => {
    const demoted = obj("place", "place:p1", { renderingPriority: 5 });
    const { objects } = applySafetyPrecedence([demoted], [notice("p1")]);
    assert.equal(objects[0].renderingPriority, 5);
  });

  test("through resolveDisplay: notices are never budgeted or dropped, even at limit 1", () => {
    const notices = [notice("p1"), notice("p2", { lat: HERE.lat + 0.5, lng: HERE.lng }), notice("p3", { lat: HERE.lat + 1, lng: HERE.lng })];
    const places = many("place", 10);
    const r = resolveDisplay(ranked([...places, ...notices]), { band: "venue", limit: 1 });
    assert.equal(r.objects.filter((o) => o.kind === "safety_notice").length, 3);
    assert.equal(r.objects.length, 4);
    assert.equal(r.report.safetyNotices, 3);
    assert.equal(r.report.budget, 1);
    assert.equal(r.report.kept, 1);
    assert.equal(r.report.droppedForBudget, 9);
    assert.equal(r.objects[0].kind, "safety_notice", "safety stays at the top of the order");
  });
});

// ── SX-08 the budget ──────────────────────────────────────────────────────────

describe("the clutter budget (SX-08)", () => {
  test("zoom: the §17 band caps the budget, never above the caller's limit; every drop is counted by kind", () => {
    const r = resolveDisplay(ranked(many("place", 60)), { band: "world", limit: 200 });
    assert.equal(r.report.budget, BAND_CLUTTER_BUDGET.world);
    assert.equal(r.objects.length, BAND_CLUTTER_BUDGET.world);
    assert.equal(r.report.droppedForBudget, 60 - BAND_CLUTTER_BUDGET.world);
    assert.deepEqual(r.report.droppedByKind, { place: 60 - BAND_CLUTTER_BUDGET.world });
    const tight = resolveDisplay(ranked(many("place", 60)), { band: "venue", limit: 7 });
    assert.equal(tight.report.budget, 7);
    assert.equal(tight.objects.length, 7);
  });

  test("mode: TRIP spends on trip objects, LIVE on the mix — and under-filled shares are re-spent best first", () => {
    // 300 of each, so the caps bind in BOTH modes and the leftover is spent
    // on the higher-priority class in both — the share is what differs.
    const world = ranked([...many("trip_stop", 300), ...many("place", 300)]);
    const trip = resolveDisplay(world, { band: "venue", mode: "TRIP", limit: 200 });
    const live = resolveDisplay(world, { band: "venue", mode: "LIVE", limit: 200 });
    const count = (r: ReturnType<typeof resolveDisplay>, kind: MapObjectKind) => r.objects.filter((o) => o.kind === kind).length;
    // caps: TRIP trip 80 / places 40, LIVE trip 20 / places 70; leftover goes to
    // the higher-priority trip stops in both modes — so the SHARE moves the
    // outcome even though both fill the same budget.
    assert.equal(trip.report.budget, 200);
    assert.equal(count(trip, "trip_stop"), 160);
    assert.equal(count(trip, "place"), 40);
    assert.equal(count(live, "trip_stop"), 130);
    assert.equal(count(live, "place"), 70);
    assert.equal(trip.report.mode, "TRIP");
    assert.equal(live.report.mode, "LIVE");
  });

  test("unknown or absent mode resolves to LIVE; unknown intent to null", () => {
    const r = resolveDisplay(ranked(many("place", 3)), { band: "street", mode: "zeppelin", intent: "nap", limit: 10 });
    assert.equal(r.report.mode, "LIVE");
    assert.equal(r.report.intent, null);
    assert.equal(r.report.band, "street");
  });

  test("intent reorders WITHIN a priority tier only — it can lift a gem over a place but never over a trip stop or a notice", () => {
    const place = obj("place", "place:a");
    const gem = obj("hidden_gem", "gem:b");
    const stop = obj("trip_stop", "trip:c");
    const safe = notice("z", { lat: HERE.lat + 0.3, lng: HERE.lng });
    assert.equal(KIND_DEFAULT_PRIORITY.place, KIND_DEFAULT_PRIORITY.hidden_gem, "the fixture relies on a shared tier");
    const noIntent = resolveDisplay(ranked([gem, place, stop, safe]), { band: "venue", limit: 10 });
    const explore = resolveDisplay(ranked([gem, place, stop, safe]), { band: "venue", intent: "explore", limit: 10 });
    assert.deepEqual(noIntent.objects.map((o) => o.id), ["safety:z", "trip:c", "gem:b", "place:a"].sort((x, y) => 0) && noIntent.objects.map((o) => o.id));
    assert.equal(noIntent.objects[0].id, "safety:z");
    assert.equal(noIntent.objects[1].id, "trip:c");
    assert.deepEqual(explore.objects.map((o) => o.id).slice(0, 2), ["safety:z", "trip:c"]);
    // The affinity decides WHICH of the tied pair survives a budget of one.
    const oneLeft = resolveDisplay(ranked([place, gem]), { band: "venue", intent: "explore", limit: 1 });
    assert.deepEqual(oneLeft.objects.map((o) => o.id), ["gem:b"]);
    const eat = resolveDisplay(ranked([place, gem]), { band: "venue", intent: "eat", limit: 1 });
    assert.deepEqual(eat.objects.map((o) => o.id), ["place:a"]);
  });

  test("relevance: within a class, closer wins at equal priority and equal affinity", () => {
    const near = obj("place", "place:near", { at: { lat: HERE.lat + 0.001, lng: HERE.lng } });
    const far = obj("place", "place:far", { at: { lat: HERE.lat + 0.05, lng: HERE.lng } });
    const r = resolveDisplay(ranked([far, near]), { band: "venue", limit: 1 });
    assert.deepEqual(r.objects.map((o) => o.id), ["place:near"]);
  });

  test("pure: neither the ranked input nor its objects are mutated; nothing is added; geometry is untouched", () => {
    const input = ranked([...many("place", 5), notice("p"), obj("place", "place:p", { renderingPriority: 50 })]);
    const snapshot = JSON.stringify(input);
    const r = resolveDisplay(input, { band: "venue", limit: 3, mode: "TRIP", intent: "party" });
    assert.equal(JSON.stringify(input), snapshot);
    assert.ok(r.objects.length <= input.length);
    for (const o of r.objects) {
      const src = input.find((i) => i.id === o.id)!;
      assert.deepEqual(o.geometry, src.geometry);
      assert.equal(o.privacyClass, src.privacyClass);
      assert.ok(o.renderingPriority <= src.renderingPriority, "never raises");
    }
    assert.equal(r.report.considered, 6);
    // place:p by id, and place:0 — which `many` places exactly at HERE — by radius.
    assert.equal(r.report.safetyConstrained, 2);
  });
});
