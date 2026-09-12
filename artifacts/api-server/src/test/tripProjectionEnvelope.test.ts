/**
 * Trips spec §19.1 — the projection envelope and its consumer rule, §22.4's
 * version-ahead invariant, §21.1's projection_lag_seconds, and the two pure
 * projection builders (timeline §19.1, safety §17.4).
 *
 * census-trips TR364-TR367 (the four envelope fields), TR368 (consumers reject
 * or visibly degrade), TR416 (sourceTripVersion may never exceed the canonical
 * version), TR394 (projection_lag_seconds), TR357 (timeline grouped on the
 * server), TR361 (a safety projection with operational states, not location).
 *
 * Every refusal here is a REASON a consumer can act on, and every acceptance
 * is a metric observation — the tests pin both halves, and the order of the
 * three refusals, because a consumer that checks staleness before schema is
 * reading a field that may not be there.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  liveEnvelope, acceptTripProjection, readTripVersion,
  TRIP_PROJECTION_SCHEMA_VERSION, TRIP_PROJECTION_FRESHNESS,
} from "../services/trips/TripProjectionEnvelope.js";
import { observeTripMetric, readTripMetric, _resetTripMetrics } from "../lib/tripMetrics.js";
import { buildTripTimeline, dateLabelOf, MAX_SYNTHESISED_DAYS } from "../services/trips/TripTimelineProjection.js";
import {
  operationalState, projectTripSafety, ARRIVED_WINDOW_MS, SAFETY_OPERATIONAL_STATES,
  type SafetySessionRow,
} from "../services/trips/TripSafetyProjection.js";

const NOW = Date.parse("2026-09-12T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

beforeEach(() => _resetTripMetrics());

describe("§19.1 liveEnvelope", () => {
  it("carries the four fields, and is 'live' when the version is known", () => {
    const e = liveEnvelope(7, new Date(NOW));
    assert.deepEqual(e, { projectionSchemaVersion: 1, generatedAt: "2026-09-12T12:00:00.000Z", sourceTripVersion: 7, freshness: "live" });
    assert.equal(TRIP_PROJECTION_SCHEMA_VERSION, 1);
  });
  it("is 'unattributable', not 'live', when the version could not be read — never 0", () => {
    const e = liveEnvelope(null, new Date(NOW));
    assert.equal(e.sourceTripVersion, null);
    assert.equal(e.freshness, "unattributable");
  });
  it("declares four freshness values; only two are emitted anywhere (the other two have no producer)", () => {
    assert.deepEqual([...TRIP_PROJECTION_FRESHNESS], ["live", "cached", "stale", "unattributable"]);
  });
});

describe("§19.1 acceptTripProjection — the consumer rule", () => {
  const good = () => ({ ...liveEnvelope(7, new Date(NOW - 10_000)) });

  it("accepts a same-schema, in-version, fresh projection and reports the lag", () => {
    const d = acceptTripProjection(good(), { acceptedSchemaVersion: 1, canonicalVersion: 7, now: NOW, metric: "T" });
    assert.ok(d.accepted);
    assert.equal(d.lagSeconds, 10);
  });
  it("SCHEMA_MISMATCH: a schema this consumer does not read", () => {
    const d = acceptTripProjection({ ...good(), projectionSchemaVersion: 2 }, { acceptedSchemaVersion: 1, now: NOW });
    assert.ok(!d.accepted && d.reason === "TRIP_PROJECTION_SCHEMA_MISMATCH");
  });
  it("SCHEMA_MISMATCH: a missing or non-numeric schema version, and an instant that is not one", () => {
    const d1 = acceptTripProjection({ ...good(), projectionSchemaVersion: "1" as any }, { acceptedSchemaVersion: 1, now: NOW });
    assert.ok(!d1.accepted && d1.reason === "TRIP_PROJECTION_SCHEMA_MISMATCH");
    const d2 = acceptTripProjection({ ...good(), generatedAt: "yesterday" }, { acceptedSchemaVersion: 1, now: NOW });
    assert.ok(!d2.accepted && d2.reason === "TRIP_PROJECTION_SCHEMA_MISMATCH");
  });
  it("§22.4 VERSION_AHEAD: sourceTripVersion above the canonical aggregate version", () => {
    const d = acceptTripProjection({ ...good(), sourceTripVersion: 9 }, { acceptedSchemaVersion: 1, canonicalVersion: 7, now: NOW });
    assert.ok(!d.accepted && d.reason === "TRIP_PROJECTION_VERSION_AHEAD");
    assert.match(d.message, /9 exceeds .*7/);
  });
  it("§22.4 cannot refuse without both numbers: unknown or unreadable canonical, or an unattributable projection", () => {
    assert.ok(acceptTripProjection({ ...good(), sourceTripVersion: 9 }, { acceptedSchemaVersion: 1, now: NOW }).accepted);
    assert.ok(acceptTripProjection({ ...good(), sourceTripVersion: 9 }, { acceptedSchemaVersion: 1, canonicalVersion: null, now: NOW }).accepted);
    assert.ok(acceptTripProjection(liveEnvelope(null, new Date(NOW)), { acceptedSchemaVersion: 1, canonicalVersion: 7, now: NOW }).accepted);
  });
  it("STALE: the projection says so, or it is older than the consumer allows", () => {
    const d1 = acceptTripProjection({ ...good(), freshness: "stale" }, { acceptedSchemaVersion: 1, now: NOW });
    assert.ok(!d1.accepted && d1.reason === "TRIP_PROJECTION_STALE");
    const d2 = acceptTripProjection(good(), { acceptedSchemaVersion: 1, maxAgeSeconds: 5, now: NOW });
    assert.ok(!d2.accepted && d2.reason === "TRIP_PROJECTION_STALE");
    assert.ok(acceptTripProjection(good(), { acceptedSchemaVersion: 1, maxAgeSeconds: 10, now: NOW }).accepted, "exactly at the limit is not over it");
  });
  it("'unattributable' is not stale", () => {
    assert.ok(acceptTripProjection(liveEnvelope(null, new Date(NOW)), { acceptedSchemaVersion: 1, now: NOW }).accepted);
  });
  it("the order is schema, then version, then staleness — a projection wrong in all three is refused for its schema", () => {
    const d = acceptTripProjection(
      { projectionSchemaVersion: 2, generatedAt: iso(0), sourceTripVersion: 99, freshness: "stale" },
      { acceptedSchemaVersion: 1, canonicalVersion: 1, now: NOW },
    );
    assert.ok(!d.accepted && d.reason === "TRIP_PROJECTION_SCHEMA_MISMATCH");
  });
  it("a projection generated 'in the future' has lag 0, not negative", () => {
    const d = acceptTripProjection(liveEnvelope(7, new Date(NOW + 5_000)), { acceptedSchemaVersion: 1, now: NOW });
    assert.ok(d.accepted && d.lagSeconds === 0);
  });
});

describe("§21.1 projection_lag_seconds", () => {
  it("is observed on ACCEPTANCE, under the consumer's label, and not on refusal", () => {
    acceptTripProjection(liveEnvelope(7, new Date(NOW - 3_000)), { acceptedSchemaVersion: 1, now: NOW, metric: "TripCompassProjection" });
    acceptTripProjection(liveEnvelope(7, new Date(NOW - 5_000)), { acceptedSchemaVersion: 1, now: NOW, metric: "TripCompassProjection" });
    acceptTripProjection({ ...liveEnvelope(7), projectionSchemaVersion: 2 }, { acceptedSchemaVersion: 1, now: NOW, metric: "TripCompassProjection" });
    const series = readTripMetric("projection_lag_seconds");
    assert.equal(series.length, 1);
    assert.deepEqual(series[0]!.labels, { projection: "TripCompassProjection" });
    assert.equal(series[0]!.count, 2, "the refused projection is not an observation");
    assert.equal(series[0]!.sum, 8);
    assert.equal(series[0]!.max, 5);
    assert.equal(series[0]!.last, 5);
  });
  it("the registry keeps one series per label set and ignores a NaN", () => {
    observeTripMetric("x", { a: "1" }, 2);
    observeTripMetric("x", { a: "2" }, 3);
    observeTripMetric("x", { a: "1" }, Number.NaN);
    const s = readTripMetric("x");
    assert.equal(s.length, 2);
    assert.equal(s.find((r) => r.labels.a === "1")!.count, 1);
    _resetTripMetrics();
    assert.deepEqual(readTripMetric("x"), []);
  });
});

describe("readTripVersion", () => {
  const sc = (row: any, error: any = null) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }) }) }),
  });
  it("returns the version, and null for an error, a missing row, or a non-number", async () => {
    assert.equal(await readTripVersion(sc({ version: 3 }), "t"), 3);
    assert.equal(await readTripVersion(sc(null, { message: "boom" }), "t"), null);
    assert.equal(await readTripVersion(sc(null), "t"), null);
    assert.equal(await readTripVersion(sc({ version: "3" }), "t"), null);
  });
});

describe("§19.1 TripTimelineProjection — grouped on the server", () => {
  const item = (id: string, dayDate: string | null) => ({ id, dayDate });

  it("emits one day per date of the trip, empty or not, then out-of-range days that carry items, and states the undated", () => {
    const t = buildTripTimeline(
      [item("a", "2026-09-13"), item("b", "2026-09-13"), item("c", "2026-09-16"), item("d", null), item("e", "2026-09-10")],
      { tripStartDate: "2026-09-12", tripEndDate: "2026-09-14" },
    );
    assert.deepEqual(t.days.map((d) => d.iso), ["2026-09-10", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-16"]);
    assert.deepEqual(t.days.map((d) => d.dateSub), ["Before trip", "Day 1", "Day 2", "Day 3", "After trip"]);
    assert.deepEqual(t.days[2]!.items.map((i) => i.id), ["a", "b"], "input order is kept within a day");
    assert.deepEqual(t.days[1]!.items, [], "an empty trip day is a day, not an absence");
    assert.equal(t.tripDayCount, 3);
    assert.deepEqual(t.undated.map((i) => i.id), ["d"]);
  });
  it("labels dates in UTC so every server groups the same way", () => {
    assert.equal(dateLabelOf("2026-09-12"), "Sat 12 Sep");
    assert.equal(dateLabelOf("not-a-date"), "not-a-date");
  });
  it("a trip without dates gets only the days its items name, with no day numbers", () => {
    const t = buildTripTimeline([item("a", "2026-09-13")], { tripStartDate: null, tripEndDate: null });
    assert.deepEqual(t.days.map((d) => [d.iso, d.dateSub]), [["2026-09-13", ""]]);
    assert.equal(t.tripDayCount, 0);
  });
  it("a trip longer than the synthesis cap is not given an empty day per date", () => {
    const t = buildTripTimeline([item("a", "2026-09-13")], { tripStartDate: "2020-01-01", tripEndDate: "2026-12-31" });
    assert.ok(t.days.length < MAX_SYNTHESISED_DAYS);
    assert.deepEqual(t.days.map((d) => d.iso), ["2026-09-13"]);
    assert.equal(t.days[0]!.dateSub.startsWith("Day "), true);
  });
  it("a dayDate that is not YYYY-MM-DD is undated, not a day", () => {
    const t = buildTripTimeline([item("a", "13/09/2026")], { tripStartDate: null, tripEndDate: null });
    assert.equal(t.days.length, 0);
    assert.equal(t.undated.length, 1);
  });
});

describe("§17.4 TripSafetyProjection — operational states, opt-in, no location", () => {
  const TRIP = "trip-1";
  const row = (o: Partial<SafetySessionRow> & { user_id: string }): SafetySessionRow => ({
    id: `s-${o.user_id}`, trip_id: TRIP, status: "active", escalation_level: 0,
    timer_start_at: iso(600_000), timer_end_at: iso(-600_000), notify_trip_crew_enabled: null,
    closed_at: null, updated_at: iso(0), ...o,
  });
  const env = liveEnvelope(4, new Date(NOW));

  it("maps status + escalation to RETURNING / NEEDS_HELP / ARRIVED, and nothing else to a state", () => {
    assert.equal(operationalState({ status: "active", escalation_level: 0, closed_at: null }, NOW), "RETURNING");
    assert.equal(operationalState({ status: "active", escalation_level: 1, closed_at: null }, NOW), "NEEDS_HELP");
    assert.equal(operationalState({ status: "missed", escalation_level: 0, closed_at: null }, NOW), "NEEDS_HELP");
    assert.equal(operationalState({ status: "safe", escalation_level: 0, closed_at: iso(60_000) }, NOW), "ARRIVED");
    assert.equal(operationalState({ status: "safe", escalation_level: 0, closed_at: iso(ARRIVED_WINDOW_MS + 1) }, NOW), null, "ARRIVED is time-limited");
    assert.equal(operationalState({ status: "safe", escalation_level: 0, closed_at: null }, NOW), null, "an arrival that cannot be placed in time is not claimed");
    assert.equal(operationalState({ status: "pending", escalation_level: 0, closed_at: null }, NOW), null);
    assert.equal(operationalState({ status: "cancelled", escalation_level: 0, closed_at: null }, NOW), null);
    assert.deepEqual([...SAFETY_OPERATIONAL_STATES], ["RETURNING", "ARRIVED", "NEEDS_HELP"]);
  });

  it("projects only members who opted in — pref or session flag — and always the viewer's own; the rest are COUNTED", () => {
    const p = projectTripSafety({
      tripId: TRIP, viewerId: "me", now: NOW,
      crewIds: new Set(["me", "pref", "flag", "silent"]),
      sessions: [
        row({ user_id: "me" }),
        row({ user_id: "pref" }),
        row({ user_id: "flag", notify_trip_crew_enabled: true }),
        row({ user_id: "silent" }),
      ],
      sharePrefs: new Map([["pref", true], ["silent", false]]),
    }, env);
    assert.deepEqual(p.members.map((m) => m.userId).sort(), ["flag", "me", "pref"]);
    assert.equal(p.withheld, 1, "an empty list must never read as 'nobody is walking home'");
    assert.equal(p.projectionSchemaVersion, 1);
    assert.equal(p.sourceTripVersion, 4);
    assert.equal(p.freshness, "live");
  });

  it("excludes sessions not attached to this trip and sessions of non-crew, without counting them", () => {
    const p = projectTripSafety({
      tripId: TRIP, viewerId: "me", now: NOW,
      crewIds: new Set(["me", "crew"]),
      sessions: [row({ user_id: "crew", trip_id: "other-trip", notify_trip_crew_enabled: true }), row({ user_id: "stranger", notify_trip_crew_enabled: true })],
      sharePrefs: new Map(),
    }, env);
    assert.deepEqual(p.members, []);
    assert.equal(p.withheld, 0);
  });

  it("orders NEEDS_HELP first, counts it, nulls the timer on ARRIVED, and carries no coordinates", () => {
    const p = projectTripSafety({
      tripId: TRIP, viewerId: "me", now: NOW,
      crewIds: new Set(["a", "b", "c"]),
      sessions: [
        row({ user_id: "a", status: "safe", closed_at: iso(1000), notify_trip_crew_enabled: true }),
        row({ user_id: "b", notify_trip_crew_enabled: true }),
        row({ user_id: "c", escalation_level: 2, notify_trip_crew_enabled: true }),
      ],
      sharePrefs: new Map(),
    }, env);
    assert.deepEqual(p.members.map((m) => [m.userId, m.state]), [["c", "NEEDS_HELP"], ["b", "RETURNING"], ["a", "ARRIVED"]]);
    assert.equal(p.needsHelpCount, 1);
    assert.equal(p.members[2]!.timerEndAt, null);
    assert.equal(p.members[0]!.escalationLevel, 2);
    const LOCATION_KEYS = new Set(["lat", "lng", "latitude", "longitude", "exactCoords", "areaLabel", "city", "district", "location"]);
    for (const m of p.members) {
      assert.deepEqual(Object.keys(m).filter((k) => LOCATION_KEYS.has(k)), [], "a safety member state must not carry location");
      assert.deepEqual(Object.keys(m).sort(), ["escalationLevel", "sessionId", "since", "state", "timerEndAt", "userId"]);
    }
  });
});
