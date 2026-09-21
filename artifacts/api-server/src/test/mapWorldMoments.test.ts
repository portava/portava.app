/**
 * worldMomentProducer — Sensing §7 SX-03: world_pulse promoted into
 * world-change projections, derived only from already-published aggregates.
 *
 * The pulses under test are REAL: they come out of `deriveWorldPulse` over
 * activity zones that clear the k floor, so a moment can only ever be attached
 * to a cell the pulse producer itself was willing to publish.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapWorldMoments.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  TRAVELER_SURGE_MIN_BUCKET,
  WORLD_CHANGES,
  WORLD_CHANGE_PRECEDENCE,
  WORLD_CHANGE_TITLES,
  WORLD_CHANGE_TREND,
  WORLD_CHANGE_TRUTH,
  attachWorldMoments,
  type PromotedPulsePayload,
} from "../lib/mapProducers/worldMomentProducer.js";
import { deriveWorldPulse } from "../lib/mapProducers/worldPulseProducer.js";
import { MIN_ZONE_COHORT, cellFor, cellPolygon } from "../lib/mapAggregation.js";
import { parseBbox } from "../lib/mapProjection.js";
import {
  ACTIVITY_LEVELS,
  KIND_DEFAULT_PRIORITY,
  TRUTH_CLASSES,
  centroidOf,
  type ActivityLevel,
  type MapObject,
  type TrendState,
} from "../lib/mapObjects.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

/** zoom 8 is the city band; the pulse grid sits two steps coarser (zoom 6). */
const ZOOM = 8;
const BBOX = parseBbox("95.0,0.0,115.0,25.0")!;
const HERE = { lat: 16.05, lng: 108.2 }; // Da Nang
const FAR = { lat: 13.75, lng: 100.5 }; // Bangkok — a different zoom-6 cell
const K = MIN_ZONE_COHORT;

function zone(over: Partial<MapObject> & { at?: { lat: number; lng: number }; count?: number; trend?: TrendState } = {}): MapObject {
  const at = over.at ?? HERE;
  const cell = cellFor(at.lat, at.lng, ZOOM)!;
  const o: MapObject = {
    id: over.id ?? `az:${cell.key}:${Math.random().toString(36).slice(2, 7)}`,
    kind: "activity_zone",
    geometry: cellPolygon(cell),
    title: "travelers active",
    privacyClass: "aggregate_only",
    renderingPriority: KIND_DEFAULT_PRIORITY.activity_zone,
    count: over.count ?? K,
    freshness: "live",
    confidence: "live",
  };
  if (over.trend) o.trend = over.trend;
  return o;
}

function flow(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  flowState: string,
  over: { inferred?: boolean; id?: string } = {},
): MapObject {
  return {
    id: over.id ?? `flow:${from.lat}:${to.lat}:${flowState}`,
    kind: "crowd_flow",
    geometry: { type: "LineString", coordinates: [[from.lng, from.lat], [to.lng, to.lat]] },
    title: flowState,
    privacyClass: "aggregate_only",
    renderingPriority: KIND_DEFAULT_PRIORITY.crowd_flow,
    count: K,
    payload: {
      observed: { flowState, fromZoneId: "a", toZoneId: "b", cohortSize: K, signalFamilies: [], windowMinutes: 60, observedAt: "x" },
      inferred: over.inferred ? { label: "Possible cause", cause: "Rooftop set", confidence: "provisional", basis: [] } : null,
    },
  };
}

function travelerFlow(to: { lat: number; lng: number }, cohortBucket: ActivityLevel): MapObject {
  return {
    id: `tflow:${cohortBucket}`,
    kind: "traveler_flow",
    geometry: { type: "LineString", coordinates: [[FAR.lng, FAR.lat], [to.lng, to.lat]] },
    title: "travelers moving",
    privacyClass: "aggregate_only",
    renderingPriority: KIND_DEFAULT_PRIORITY.traveler_flow,
    payload: { basis: "observed_accepted_plans", cohortBucket },
  };
}

/** Real pulses over the given aggregation output. */
function pulsesOver(objects: MapObject[]): MapObject[] {
  const r = deriveWorldPulse(objects, { bbox: BBOX, zoom: ZOOM });
  assert.ok(r.pulses.length >= 1, "the fixture must yield at least one pulse");
  return r.pulses;
}

function payloadOf(p: MapObject): PromotedPulsePayload {
  return p.payload as PromotedPulsePayload;
}

// ── vocabulary ────────────────────────────────────────────────────────────────

describe("vocabulary", () => {
  test("the seven changes are Sensing §7's, and every table is total over them", () => {
    assert.deepEqual([...WORLD_CHANGES], [
      "heating_up", "forming", "moving", "clearing", "unexpected_activity", "event_spillover", "traveler_surge",
    ]);
    assert.deepEqual([...WORLD_CHANGE_PRECEDENCE].sort(), [...WORLD_CHANGES].sort());
    for (const ch of WORLD_CHANGES) {
      assert.equal(typeof WORLD_CHANGE_TITLES[ch], "string");
      assert.ok(TRUTH_CLASSES.includes(WORLD_CHANGE_TRUTH[ch]));
    }
    // A cause hypothesis and a declared plan are not sightings.
    assert.equal(WORLD_CHANGE_TRUTH.event_spillover, "inferred");
    assert.equal(WORLD_CHANGE_TRUTH.traveler_surge, "inferred");
    assert.equal(WORLD_CHANGE_TRUTH.heating_up, "observed");
    assert.equal(WORLD_CHANGE_TREND.heating_up, "getting_busier");
    assert.equal(WORLD_CHANGE_TREND.clearing, "getting_quieter");
    assert.ok(ACTIVITY_LEVELS.indexOf(TRAVELER_SURGE_MIN_BUCKET) > ACTIVITY_LEVELS.indexOf("quiet"));
  });
});

// ── changes ───────────────────────────────────────────────────────────────────

describe("each change, from its own evidence", () => {
  test("heating up — a k-cohort of zones carrying an upward trend; title, trend and truth class follow", () => {
    const zones = [zone({ trend: "getting_busier" }), zone({ trend: "getting_busier" })];
    const pulses = pulsesOver(zones);
    const before = pulses[0];
    const { pulses: out, report } = attachWorldMoments(pulses, zones, { zoom: ZOOM });
    const p = out[0];
    assert.equal(p.kind, "world_pulse", "promoted, not re-kinded");
    assert.equal(p.id, before.id);
    assert.equal(p.title, "Heating up");
    assert.equal(p.subtitle, before.title, "the level moves to the subtitle, it is not lost");
    assert.equal(p.trend, "getting_busier");
    assert.equal(p.truthClass, "observed");
    const m = payloadOf(p).moment!;
    assert.equal(m.change, "heating_up");
    assert.deepEqual(m.also, []);
    assert.equal(m.basis, "derived_from_published_aggregates");
    assert.equal(m.evidence.zonesWithTrend, 2);
    assert.deepEqual(report, {
      considered: 1, attached: 1, unchanged: 0,
      byChange: { heating_up: 1, forming: 0, moving: 0, clearing: 0, unexpected_activity: 0, event_spillover: 0, traveler_surge: 0 },
    });
  });

  test("clearing — a downward zone trend, or a dispersing outbound flow", () => {
    const zones = [zone({ trend: "cooling" })];
    const a = attachWorldMoments(pulsesOver(zones), zones, { zoom: ZOOM }).pulses[0];
    assert.equal(payloadOf(a).moment?.change, "clearing");
    assert.equal(a.trend, "getting_quieter");

    const plain = [zone()];
    const ctx = [...plain, flow(HERE, FAR, "dispersing")];
    const b = attachWorldMoments(pulsesOver(plain), ctx, { zoom: ZOOM }).pulses[0];
    assert.equal(payloadOf(b).moment?.change, "clearing");
    assert.equal(payloadOf(b).moment?.evidence.flowsOut, 1);
  });

  test("forming — emerging movement INTO the cell; moving — strong/moderate movement at either end", () => {
    const plain = [zone()];
    const forming = attachWorldMoments(pulsesOver(plain), [...plain, flow(FAR, HERE, "emerging_movement")], { zoom: ZOOM }).pulses[0];
    assert.equal(payloadOf(forming).moment?.change, "forming");
    assert.equal(payloadOf(forming).moment?.evidence.flowsIn, 1);
    assert.equal(forming.trend, undefined, "forming implies no §7 trend");

    const movingIn = attachWorldMoments(pulsesOver(plain), [...plain, flow(FAR, HERE, "strong_movement")], { zoom: ZOOM }).pulses[0];
    assert.equal(payloadOf(movingIn).moment?.change, "moving");
    const movingOut = attachWorldMoments(pulsesOver(plain), [...plain, flow(HERE, FAR, "moderate_movement")], { zoom: ZOOM }).pulses[0];
    assert.equal(payloadOf(movingOut).moment?.change, "moving");
  });

  test("unexpected activity — an unusual flow touching the cell, and it outranks everything", () => {
    const zones = [zone({ trend: "getting_busier" }), zone({ trend: "getting_busier" })];
    const ctx = [...zones, flow(FAR, HERE, "unusual_movement"), flow(FAR, HERE, "strong_movement", { inferred: true, id: "f2" })];
    const p = attachWorldMoments(pulsesOver(zones), ctx, { zoom: ZOOM }).pulses[0];
    const m = payloadOf(p).moment!;
    assert.equal(m.change, "unexpected_activity");
    assert.deepEqual(m.also, ["event_spillover", "heating_up", "moving"]);
    assert.equal(p.truthClass, "observed");
  });

  test("event spillover — an inbound flow carrying an INFERRED cause; the pulse is `inferred`, never observed", () => {
    const plain = [zone()];
    const p = attachWorldMoments(pulsesOver(plain), [...plain, flow(FAR, HERE, "moderate_movement", { inferred: true })], { zoom: ZOOM }).pulses[0];
    const m = payloadOf(p).moment!;
    assert.equal(m.change, "event_spillover");
    assert.deepEqual(m.also, ["moving"]);
    assert.equal(m.truthClass, "inferred");
    assert.equal(p.truthClass, "inferred");
    assert.equal(m.evidence.inferredCauses, 1);
  });

  test("traveler surge — an inbound traveler-flow edge at or above the surge bucket; below it, nothing", () => {
    const plain = [zone()];
    const surge = attachWorldMoments(pulsesOver(plain), [...plain, travelerFlow(HERE, "busy")], { zoom: ZOOM }).pulses[0];
    assert.equal(payloadOf(surge).moment?.change, "traveler_surge");
    assert.equal(payloadOf(surge).moment?.truthClass, "inferred");
    assert.equal(payloadOf(surge).moment?.evidence.travelerFlowsIn, 1);

    const mild = attachWorldMoments(pulsesOver(plain), [...plain, travelerFlow(HERE, "moderate")], { zoom: ZOOM }).pulses[0];
    assert.equal(payloadOf(mild).moment, null);
    // An OUTBOUND edge (destination elsewhere) is not a surge here.
    const away = { ...travelerFlow(HERE, "peak"), geometry: { type: "LineString" as const, coordinates: [[HERE.lng, HERE.lat], [FAR.lng, FAR.lat]] as [number, number][] } };
    const out = attachWorldMoments(pulsesOver(plain), [...plain, away], { zoom: ZOOM }).pulses[0];
    assert.equal(payloadOf(out).moment, null);
  });

  test("evidence in a DIFFERENT cell attaches nothing here", () => {
    const plain = [zone()];
    const elsewhere = [zone({ at: FAR, trend: "getting_busier" }), zone({ at: FAR, trend: "getting_busier" }), flow(HERE, FAR, "emerging_movement")];
    const out = attachWorldMoments(pulsesOver(plain), [...plain, ...elsewhere], { zoom: ZOOM }).pulses;
    const here = out.find((p) => {
      const c = centroidOf(p.geometry)!;
      return Math.abs(c.lat - HERE.lat) < 6 && Math.abs(c.lng - HERE.lng) < 6;
    })!;
    assert.equal(payloadOf(here).moment, null);
  });
});

// ── the properties that make it safe ──────────────────────────────────────────

describe("properties", () => {
  test("suppression is not a signal: a sub-k trend carrier serializes identically to no carrier at all", () => {
    const published = zone({ id: "az:pub" });
    const pulses = pulsesOver([published]);
    const none = attachWorldMoments(pulses, [published], { zoom: ZOOM }).pulses;
    const subK = attachWorldMoments(pulses, [published, zone({ id: "az:sub", count: K - 1, trend: "getting_busier" })], { zoom: ZOOM }).pulses;
    assert.equal(JSON.stringify(subK), JSON.stringify(none));
    assert.equal(payloadOf(none[0]).moment, null);
    assert.equal(none[0].truthClass, "observed");
  });

  test("no headcount reaches the wire: the pulse still has no `count`, and evidence counts aggregates", () => {
    const zones = [zone({ trend: "getting_busier" }), zone({ trend: "getting_busier" }), zone({ trend: "getting_busier" })];
    const p = attachWorldMoments(pulsesOver(zones), zones, { zoom: ZOOM }).pulses[0];
    assert.equal("count" in p, false);
    const text = JSON.stringify(p);
    assert.equal(text.includes(String(K * 3)), false, "the summed cohort must not appear anywhere");
    assert.equal(payloadOf(p).moment?.evidence.zonesWithTrend, 3);
    assert.equal(p.coverage, "several");
  });

  test("coverage: density-only cells are `unknown`, people-backed cells bucket by contributing aggregates", () => {
    const venues: MapObject[] = Array.from({ length: 8 }, (_, i) => ({
      id: `place:v${i}`,
      kind: "place",
      geometry: { type: "Point", coordinates: [HERE.lng + i * 0.001, HERE.lat] },
      title: `Venue ${i}`,
      privacyClass: "place_level",
      renderingPriority: KIND_DEFAULT_PRIORITY.place,
    }));
    const dense = attachWorldMoments(pulsesOver(venues), venues, { zoom: ZOOM }).pulses[0];
    assert.equal(dense.coverage, "unknown");
    const one = attachWorldMoments(pulsesOver([zone()]), [], { zoom: ZOOM }).pulses[0];
    assert.equal(one.coverage, "few");
    const four = [zone(), zone(), zone(), zone()];
    const many = attachWorldMoments(pulsesOver(four), four, { zoom: ZOOM }).pulses[0];
    assert.equal(many.coverage, "many");
  });

  test("pure: inputs are not mutated, non-pulses are ignored, and a pulse without a payload still works", () => {
    const zones = [zone({ trend: "getting_busier" }), zone({ trend: "getting_busier" })];
    const pulses = pulsesOver(zones);
    const snapshot = JSON.stringify({ pulses, zones });
    attachWorldMoments([...pulses, zones[0]], zones, { zoom: ZOOM });
    assert.equal(JSON.stringify({ pulses, zones }), snapshot);
    const { pulses: out, report } = attachWorldMoments([{ ...pulses[0], payload: undefined }], zones, { zoom: ZOOM });
    assert.equal(out.length, 1);
    assert.equal(report.considered, 1);
    assert.equal(payloadOf(out[0]).moment?.change, "heating_up");
  });
});
