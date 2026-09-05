/**
 * temporalProjection — Map spec §15 Time Machine PRODUCER (lib/temporalProjection).
 *
 * The producer is the source §15 never had: no route emitted a `prediction`
 * object or any per-offset historical state, so the client could only relabel
 * the NOW map and the mode was held closed. These tests pin the two §37 rules
 * this producer exists to keep:
 *
 *   • "Do not make predictions look like observations." Every forecast object is
 *     kind 'prediction', carries no observedAt, and never a live freshness.
 *   • History is READ, never reconstructed. A missing/empty snapshot record is
 *     an honest "no history yet" (`available: false` for a read failure), never
 *     a fabricated past; historical objects wear freshness 'historical'.
 *
 * And the one privacy rule the accepted_plan source turns on: a predicted zone
 * cohort is published ONLY when it clears PRIVACY_THRESHOLD_V1 — the same gate
 * crowd flow uses — so a single traveller's future position can never leak.
 *
 * Pure and offline: rows in, MapObjects out, `now` injected.
 *
 * Run:
 *   node --import tsx/esm --test src/test/temporalProjection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseTemporalTarget,
  classifyTemporalMode,
  projectEventForecast,
  projectItineraryStopForecast,
  aggregatePlanArrivals,
  projectHistory,
  projectForecast,
  eventForecastConfidence,
  TEMPORAL_NOW_TOLERANCE_MS,
  MAX_OFFSET_MINUTES,
  type TemporalTarget,
  type PlanArrival,
  type SnapshotVersionRow,
  type HistoricalPlaceGeometry,
} from "../lib/temporalProjection.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const MIN = 60_000;

// Fixtures shaped the way production emits them (events/route_stops rows).
interface EventRow {
  id: string;
  title: string;
  location_name: string | null;
  location_lat: number | null;
  location_lng: number | null;
  starts_at: string | null;
  ends_at: string | null;
  state: string;
}

interface StopRow {
  id: string;
  title: string;
  structured_location: { label?: string; lat?: number; lng?: number } | null;
  planned_arrival_time: string | null;
  planned_departure_time: string | null;
}

function forecastTarget(offsetMin: number): TemporalTarget {
  return parseTemporalTarget({ offsetMinutes: offsetMin }, NOW) as TemporalTarget;
}

// ── classifyTemporalMode / parseTemporalTarget ────────────────────────────────

describe("classifyTemporalMode — which side of the present", () => {
  it("treats a small delta either way as 'now'", () => {
    assert.equal(classifyTemporalMode(NOW, NOW), "now");
    assert.equal(classifyTemporalMode(NOW + TEMPORAL_NOW_TOLERANCE_MS, NOW), "now");
    assert.equal(classifyTemporalMode(NOW - TEMPORAL_NOW_TOLERANCE_MS, NOW), "now");
  });
  it("classifies beyond the tolerance as forecast / historical", () => {
    assert.equal(classifyTemporalMode(NOW + TEMPORAL_NOW_TOLERANCE_MS + 1, NOW), "forecast");
    assert.equal(classifyTemporalMode(NOW - TEMPORAL_NOW_TOLERANCE_MS - 1, NOW), "historical");
  });
});

describe("parseTemporalTarget", () => {
  it("resolves offsetMinutes into a window ±half-width around t+offset", () => {
    const t = parseTemporalTarget({ offsetMinutes: 60 }, NOW);
    assert.ok(t);
    assert.equal(t.at, NOW + 60 * MIN);
    assert.equal(t.mode, "forecast");
    assert.equal(t.windowStart, t.at - 15 * MIN);
    assert.equal(t.windowEnd, t.at + 15 * MIN);
  });

  it("classifies a negative offset as historical", () => {
    const t = parseTemporalTarget({ offsetMinutes: -60 }, NOW);
    assert.ok(t);
    assert.equal(t.mode, "historical");
  });

  it("resolves a named window with an explicit midpoint 'at'", () => {
    const ws = NOW - 26 * 3600_000;
    const we = NOW - 24 * 3600_000;
    const at = ws + 3600_000;
    const t = parseTemporalTarget({ windowStartsAt: new Date(ws).toISOString(), windowEndsAt: new Date(we).toISOString(), at: new Date(at).toISOString() }, NOW);
    assert.ok(t);
    assert.equal(t.at, at);
    assert.equal(t.mode, "historical");
  });

  it("defaults 'at' to the window midpoint when omitted or out of the window", () => {
    const ws = NOW - 26 * 3600_000;
    const we = NOW - 24 * 3600_000;
    const t = parseTemporalTarget({ windowStartsAt: new Date(ws).toISOString(), windowEndsAt: new Date(we).toISOString() }, NOW);
    assert.ok(t);
    assert.equal(t.at, Math.round((ws + we) / 2));
  });

  it("rejects malformed, inverted, non-integer and out-of-range targets", () => {
    assert.equal(parseTemporalTarget({}, NOW), null);
    assert.equal(parseTemporalTarget({ offsetMinutes: "abc" }, NOW), null);
    assert.equal(parseTemporalTarget({ offsetMinutes: 1.5 }, NOW), null);
    assert.equal(parseTemporalTarget({ offsetMinutes: MAX_OFFSET_MINUTES + 1 }, NOW), null);
    const ws = new Date(NOW).toISOString();
    const we = new Date(NOW - MIN).toISOString(); // inverted
    assert.equal(parseTemporalTarget({ windowStartsAt: ws, windowEndsAt: we }, NOW), null);
  });
});

// ── Source 1: events ──────────────────────────────────────────────────────────

describe("projectEventForecast", () => {
  const target = forecastTarget(60);
  const covering: EventRow = {
    id: "ev1",
    title: "Rooftop set",
    location_name: "Sky Bar",
    location_lat: 16.05,
    location_lng: 108.2,
    starts_at: new Date(NOW + 30 * MIN).toISOString(),
    ends_at: new Date(NOW + 120 * MIN).toISOString(),
    state: "published",
  };

  it("emits a prediction for an event whose window covers the target", () => {
    const o = projectEventForecast(covering, target);
    assert.ok(o);
    assert.equal(o.kind, "prediction");
    assert.equal(o.id, "prediction:event:ev1");
    // §37: a prediction was never observed.
    assert.equal(o.observedAt, undefined);
    // §37: never live.
    assert.notEqual(o.freshness, "live");
    assert.equal(o.confidence, "strong");
    assert.equal(o.privacyClass, "place_level");
    assert.equal(o.expiresAt, covering.ends_at);
  });

  it("returns null outside forecast mode", () => {
    assert.equal(projectEventForecast(covering, parseTemporalTarget({ offsetMinutes: -60 }, NOW) as TemporalTarget), null);
    assert.equal(projectEventForecast(covering, parseTemporalTarget({ offsetMinutes: 0 }, NOW) as TemporalTarget), null);
  });

  it("returns null when the event window does not cover the target", () => {
    const notCovering: EventRow = { ...covering, starts_at: new Date(NOW + 200 * MIN).toISOString(), ends_at: new Date(NOW + 240 * MIN).toISOString() };
    assert.equal(projectEventForecast(notCovering, target), null);
  });

  it("returns null when coordinates were redacted (null lat/lng)", () => {
    assert.equal(projectEventForecast({ ...covering, location_lat: null, location_lng: null }, target), null);
  });

  it("grades confidence: scheduled/published is strong, otherwise likely_current", () => {
    assert.equal(eventForecastConfidence("published"), "strong");
    assert.equal(eventForecastConfidence("confirmed"), "strong");
    assert.equal(eventForecastConfidence("tentative"), "likely_current");
    assert.equal(eventForecastConfidence(undefined), "likely_current");
  });
});

// ── Source 2: the viewer's own itinerary stops ────────────────────────────────

describe("projectItineraryStopForecast", () => {
  const target = forecastTarget(60);
  const stop: StopRow = {
    id: "s1",
    title: "Lunch",
    structured_location: { label: "Bun Cha", lat: 16.06, lng: 108.21 },
    planned_arrival_time: new Date(NOW + 55 * MIN).toISOString(),
    planned_departure_time: new Date(NOW + 90 * MIN).toISOString(),
  };

  it("emits a place-level prediction for the viewer's own covered stop", () => {
    const o = projectItineraryStopForecast(stop, target);
    assert.ok(o);
    assert.equal(o.kind, "prediction");
    assert.equal(o.privacyClass, "place_level");
    assert.equal(o.observedAt, undefined);
    assert.equal(o.confidence, "likely_current");
    assert.equal(o.title, "Lunch");
  });

  it("treats a missing planned_departure as an instant at arrival", () => {
    const instant: StopRow = { ...stop, planned_arrival_time: new Date(NOW + 60 * MIN).toISOString(), planned_departure_time: null };
    assert.ok(projectItineraryStopForecast(instant, target));
    const away: StopRow = { ...stop, planned_arrival_time: new Date(NOW + 200 * MIN).toISOString(), planned_departure_time: null };
    assert.equal(projectItineraryStopForecast(away, target), null);
  });

  it("returns null with no coordinate and outside forecast mode", () => {
    assert.equal(projectItineraryStopForecast({ ...stop, structured_location: { label: "x" } }, target), null);
    assert.equal(projectItineraryStopForecast(stop, parseTemporalTarget({ offsetMinutes: -60 }, NOW) as TemporalTarget), null);
  });
});

// ── Source 3: accepted-plan arrivals aggregated to zones ──────────────────────

function arrivalCohort(count: number, opts: { zoneId?: string; distinctGroups?: number; acceptedAgoMin?: number } = {}): PlanArrival[] {
  const zoneId = opts.zoneId ?? "zone-a";
  const groups = opts.distinctGroups ?? count; // default: each actor its own solo group
  const acceptedAtMs = NOW - (opts.acceptedAgoMin ?? 15) * MIN;
  return Array.from({ length: count }, (_, i): PlanArrival => ({
    zoneId,
    zoneCentroid: { lat: 16.05, lng: 108.2 },
    actorId: `actor-${i + 1}`,
    groupKey: `group-${i % groups}`,
    acceptedAtMs,
  }));
}

describe("aggregatePlanArrivals — the privacy gate", () => {
  const target = forecastTarget(60);

  it("publishes ONE aggregate-only prediction when the cohort clears every gate", () => {
    const arrivals = arrivalCohort(PRIVACY_THRESHOLD_V1.minUniqueActors); // 15 actors, 15 groups
    const res = aggregatePlanArrivals(arrivals, target, NOW);
    assert.equal(res.published, 1);
    assert.equal(res.withheld, 0);
    const o = res.objects[0];
    assert.equal(o.kind, "prediction");
    assert.equal(o.privacyClass, "aggregate_only");
    assert.equal(o.count, PRIVACY_THRESHOLD_V1.minUniqueActors);
    assert.equal(o.observedAt, undefined);
  });

  it("withholds a sub-k cohort with a reason, never an object", () => {
    const res = aggregatePlanArrivals(arrivalCohort(PRIVACY_THRESHOLD_V1.minUniqueActors - 1), target, NOW);
    assert.equal(res.published, 0);
    assert.equal(res.withheld, 1);
    assert.equal(res.objects.length, 0);
    assert.equal(res.refusals["zone-a"], "below_actor_threshold");
  });

  it("withholds when too few independent groups", () => {
    const res = aggregatePlanArrivals(
      arrivalCohort(PRIVACY_THRESHOLD_V1.minUniqueActors, { distinctGroups: PRIVACY_THRESHOLD_V1.minIndependentGroups - 1 }),
      target,
      NOW,
    );
    assert.equal(res.published, 0);
    assert.equal(res.refusals["zone-a"], "below_group_threshold");
  });

  it("withholds when the publication delay has not elapsed", () => {
    const res = aggregatePlanArrivals(
      arrivalCohort(PRIVACY_THRESHOLD_V1.minUniqueActors, { acceptedAgoMin: 1 }),
      target,
      NOW,
    );
    assert.equal(res.published, 0);
    assert.equal(res.refusals["zone-a"], "publication_delay_not_elapsed");
  });

  it("produces nothing outside forecast mode", () => {
    const res = aggregatePlanArrivals(arrivalCohort(20), parseTemporalTarget({ offsetMinutes: -60 }, NOW) as TemporalTarget, NOW);
    assert.equal(res.objects.length, 0);
  });
});

// ── Historical: read, never reconstruct ───────────────────────────────────────

const PLACE_A: HistoricalPlaceGeometry = { lat: 16.05, lng: 108.2, name: "An Thuong" };

function snapshotRow(over: Partial<SnapshotVersionRow> = {}): SnapshotVersionRow {
  return {
    subject_id: "place-a",
    claim_type: "crowd.level",
    value: { level: "busy" },
    confidence_band: "strong",
    privacy_eligible: true,
    observed_at: new Date(NOW - 24 * 3600_000).toISOString(),
    expires_at: new Date(NOW - 20 * 3600_000).toISOString(),
    ...over,
  };
}

describe("projectHistory — honest empty vs populated", () => {
  const target = parseTemporalTarget({ offsetMinutes: -22 * 60 }, NOW) as TemporalTarget; // 22h ago → within the row window

  it("a READ FAILURE (null rows) is available:false — never a fabricated empty past", () => {
    const res = projectHistory(null, new Map(), target);
    assert.equal(res.available, false);
    assert.equal(res.objects.length, 0);
  });

  it("an empty-but-successful read is available:true with no objects", () => {
    const res = projectHistory([], new Map(), target);
    assert.equal(res.available, true);
    assert.equal(res.objects.length, 0);
  });

  it("emits an OBSERVED historical place object with freshness 'historical'", () => {
    const places = new Map<string, HistoricalPlaceGeometry>([["place-a", PLACE_A]]);
    const res = projectHistory([snapshotRow()], places, target);
    assert.equal(res.available, true);
    assert.equal(res.covering, 1);
    assert.equal(res.objects.length, 1);
    const o = res.objects[0];
    assert.equal(o.kind, "place");
    assert.equal(o.freshness, "historical");
    assert.equal(o.activity, "busy"); // reconstructed via the SAME live mapper
    assert.notEqual(o.kind, "prediction");
  });

  it("skips a row that was not privacy-eligible when recorded", () => {
    const places = new Map<string, HistoricalPlaceGeometry>([["place-a", PLACE_A]]);
    const res = projectHistory([snapshotRow({ privacy_eligible: false })], places, target);
    assert.equal(res.covering, 0);
    assert.equal(res.objects.length, 0);
  });

  it("skips rows whose validity window does not cover the target instant", () => {
    const places = new Map<string, HistoricalPlaceGeometry>([["place-a", PLACE_A]]);
    const notCovering = snapshotRow({
      observed_at: new Date(NOW - 4 * 3600_000).toISOString(),
      expires_at: new Date(NOW - 3 * 3600_000).toISOString(),
    });
    const res = projectHistory([notCovering], places, target);
    assert.equal(res.covering, 0);
  });

  it("drops a covering row whose subject place has no geometry", () => {
    const res = projectHistory([snapshotRow()], new Map(), target);
    assert.equal(res.covering, 1); // counted as covering
    assert.equal(res.objects.length, 0); // but no geometry to place it
  });

  it("returns empty outside historical mode", () => {
    const places = new Map<string, HistoricalPlaceGeometry>([["place-a", PLACE_A]]);
    const res = projectHistory([snapshotRow()], places, forecastTarget(60));
    assert.equal(res.objects.length, 0);
  });
});

// ── projectForecast — the three sources folded ────────────────────────────────

describe("projectForecast — merges events, itinerary and accepted plans", () => {
  it("counts each source and aggregates plan arrivals through the gate", () => {
    const target = forecastTarget(60);
    const events: EventRow[] = [
      {
        id: "ev1",
        title: "Set",
        location_name: null,
        location_lat: 16.05,
        location_lng: 108.2,
        starts_at: new Date(NOW + 40 * MIN).toISOString(),
        ends_at: new Date(NOW + 100 * MIN).toISOString(),
        state: "published",
      },
    ];
    const stops: StopRow[] = [
      {
        id: "s1",
        title: "Dinner",
        structured_location: { label: "x", lat: 16.06, lng: 108.21 },
        planned_arrival_time: new Date(NOW + 58 * MIN).toISOString(),
        planned_departure_time: new Date(NOW + 80 * MIN).toISOString(),
      },
    ];
    const res = projectForecast(
      { events, itineraryStops: stops, planArrivals: arrivalCohort(PRIVACY_THRESHOLD_V1.minUniqueActors) },
      target,
      NOW,
    );
    assert.equal(res.events, 1);
    assert.equal(res.itinerary, 1);
    assert.equal(res.plan.published, 1);
    assert.equal(res.objects.length, 3);
    for (const o of res.objects) {
      assert.equal(o.kind, "prediction");
      assert.equal(o.observedAt, undefined);
      assert.notEqual(o.freshness, "live");
    }
  });
});
