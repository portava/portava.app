/**
 * Trips spec §17.1 / §3.2 — `buildTripHealthProjection`, the reads that feed
 * health and phase, their refusals, and (below) the §19.2-style read and the
 * timeline's derived AT_RISK plans. census-trips TR38–TR45, TR314, TR317,
 * TR396.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { buildTripHealthProjection } from "../services/trips/TripHealthProjection.js";
import { _resetTripMetrics } from "../lib/tripMetrics.js";
import { DRIVE_METRES_PER_SECOND, DRIVE_WAIT_SECONDS, WALK_MAX_METRES } from "../services/trips/TravelTimeProvider.js";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PLACE_A   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1";
const PLACE_B   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2";
const EARTH_RADIUS_M = 6_371_008.8;
const northOf = (lat: number, lng: number, metres: number) => ({ lat: lat + (metres / EARTH_RADIUS_M) * (180 / Math.PI), lng });
const ORIGIN = { lat: 48.8566, lng: 2.3522 };
const DEST = northOf(ORIGIN.lat, ORIGIN.lng, WALK_MAX_METRES * 5);
const TRAVEL_MIN = Math.ceil((WALK_MAX_METRES * 5 / DRIVE_METRES_PER_SECOND + DRIVE_WAIT_SECONDS) / 60);

type Row = Record<string, any>;
export function makeClient(tables: Record<string, Row[]>, errorOn: string[] = []) {
  return {
    auth: { getUser: async (token: string) => token === "owner-token" ? { data: { user: { id: OWNER_ID } }, error: null } : token === "member-token" ? { data: { user: { id: MEMBER_ID } }, error: null } : token === "other-token" ? { data: { user: { id: "33333333-3333-3333-3333-333333333333" } }, error: null } : { data: { user: null }, error: { message: "invalid" } } },
    from(table: string) {
      if (errorOn.includes(table)) {
        const f: any = { select: () => f, eq: () => f, in: () => f, is: () => f, or: () => f, gt: () => f, order: () => f, limit: () => f,
          maybeSingle: async () => ({ data: null, error: { message: `${table} unavailable` } }),
          then: (onF: any, onR: any) => Promise.resolve({ data: null, error: { message: `${table} unavailable` } }).then(onF, onR) };
        return f;
      }
      const filters: Array<(r: Row) => boolean> = []; let single = false;
      const settle = () => { const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))); return { data: single ? rows[0] ?? null : rows, error: null }; };
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
        or: () => chain, gt: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => { single = true; return settle(); },
        then: (onF: any, onR: any) => Promise.resolve(settle()).then(onF, onR),
      };
      return chain;
    },
  };
}

const T = (hhmm: string, day = "13") => `2026-09-${day}T${hhmm}:00.000Z`;
const NOW = new Date(T("12:00"));
const commitment = (id: string, o: Row = {}) => ({ id, trip_id: TRIP_ID, type: "event", starts_at: null, required_arrival_at: null, place_id: null, lateness_tolerance: null, prep_duration: null, flexibility: "flexible", ...o });
export const base = (): Record<string, Row[]> => ({
  trips: [{ id: TRIP_ID, owner_id: OWNER_ID, version: 9, title: "Paris", destination_city: "Paris", start_date: "2026-09-12", end_date: "2026-09-15", status: "active", timezone: "Europe/Paris" }],
  trip_members: [{ trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" }, { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" }],
  trip_commitments: [commitment("A", { starts_at: T("10:00"), place_id: PLACE_A }), commitment("B", { required_arrival_at: T("16:00"), place_id: PLACE_B })],
  places: [{ id: PLACE_A, latitude: ORIGIN.lat, longitude: ORIGIN.lng }, { id: PLACE_B, latitude: DEST.lat, longitude: DEST.lng }],
  trip_risks: [], safe_return_sessions: [], trip_crew_location_preferences: [], trip_plan_items: [], meetups: [],
  feature_flags: [{ flag: "trip_operational_projections_enabled", enabled: true }],
});

beforeEach(() => _resetTripMetrics());

describe("buildTripHealthProjection — health and phase from the same reads", () => {
  it("HEALTHY and FREE_TIME inside the window, under the envelope, with counts of what was looked at", async () => {
    const r = await buildTripHealthProjection(makeClient(base()) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const p = r.projection;
    assert.equal(p.projectionSchemaVersion, 1); assert.equal(p.sourceTripVersion, 9); assert.equal(p.freshness, "live");
    assert.equal(p.health, "HEALTHY"); assert.deepEqual(p.reasons, []); assert.deepEqual([...p.surfacePriority], []);
    assert.equal(p.phase.phase, "FREE_TIME"); assert.equal(p.phase.evidence.windowId, "fw:A:B");
    assert.equal(p.tripStatus, "active");
    assert.deepEqual(p.counted, { conflicts: 0, openRisks: 0, needsHelp: 0, hops: { infeasible: 0, unknown: 0 } });
    assert.equal(p.derivedFrom.freedomSourceTripVersion, 9);
  });
  it("a conflict makes it AT_RISK with the priority order; a NEEDS_HELP member makes it DISRUPTED and the phase DISRUPTED", async () => {
    const tables = base();
    tables.trip_commitments = [commitment("A", { starts_at: T("10:00"), place_id: PLACE_A }), commitment("B", { required_arrival_at: T("10:05"), place_id: PLACE_B })];
    let r = await buildTripHealthProjection(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok);
    assert.equal(r.projection.health, "AT_RISK");
    assert.deepEqual(r.projection.reasons.map((x) => x.code).sort(), ["FEASIBILITY_INFEASIBLE", "TRIP_TEMPORAL_CONFLICT"]);
    assert.equal(r.projection.counted.hops.infeasible, 1);
    assert.deepEqual([...r.projection.surfacePriority], ["logistics", "affected_commitments", "recovery"]);
    assert.notEqual(r.projection.phase.phase, "DISRUPTED", "AT_RISK is not DISRUPTED");

    tables.safe_return_sessions = [{ id: "s1", user_id: MEMBER_ID, trip_id: TRIP_ID, status: "active", escalation_level: 2, timer_start_at: T("11:00"), timer_end_at: T("13:00"), notify_trip_crew_enabled: true, closed_at: null, updated_at: T("11:00") }];
    r = await buildTripHealthProjection(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok);
    assert.equal(r.projection.health, "DISRUPTED");
    assert.equal(r.projection.reasons[0]!.code, "SAFETY_NEEDS_HELP");
    assert.deepEqual(r.projection.reasons[0]!.subjectIds, [MEMBER_ID]);
    assert.equal(r.projection.phase.phase, "DISRUPTED");
  });
  it("a NEEDS_HELP member who has not opted in is not a reason for another viewer, and is one for themself", async () => {
    const tables = base();
    tables.safe_return_sessions = [{ id: "s1", user_id: MEMBER_ID, trip_id: TRIP_ID, status: "missed", escalation_level: 0, timer_start_at: T("11:00"), timer_end_at: T("11:30"), notify_trip_crew_enabled: false, closed_at: null, updated_at: T("11:30") }];
    const owner = await buildTripHealthProjection(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(owner.ok); assert.equal(owner.projection.health, "HEALTHY");
    const self = await buildTripHealthProjection(makeClient(tables) as any, TRIP_ID, MEMBER_ID, { now: NOW });
    assert.ok(self.ok); assert.equal(self.projection.health, "DISRUPTED");
  });
  it("the risk register: realised → DISRUPTED, high/high open → AT_RISK, mitigated → nothing", async () => {
    const tables = base();
    tables.trip_risks = [{ id: "r1", trip_id: TRIP_ID, likelihood: "high", impact: "high", status: "open" }, { id: "r2", trip_id: TRIP_ID, likelihood: "high", impact: "high", status: "mitigated" }];
    let r = await buildTripHealthProjection(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok); assert.equal(r.projection.health, "AT_RISK"); assert.equal(r.projection.counted.openRisks, 1);
    tables.trip_risks.push({ id: "r3", trip_id: TRIP_ID, likelihood: "low", impact: "low", status: "realised" });
    r = await buildTripHealthProjection(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok); assert.equal(r.projection.health, "DISRUPTED");
  });
  it("ACTIVE_PLAN when a plan item is under way; TRANSIT after the window's leave-by", async () => {
    const tables = base();
    tables.trip_plan_items = [{ id: "p1", trip_id: TRIP_ID, category: "activity", status: "confirmed", starts_at: T("11:30"), ends_at: T("12:30"), day_date: "2026-09-13", removed_at: null }];
    let r = await buildTripHealthProjection(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(r.ok); assert.equal(r.projection.phase.phase, "ACTIVE_PLAN"); assert.equal(r.projection.phase.evidence.activePlanId, "p1");
    const leaveBy = new Date(Date.parse(T("16:00")) - TRAVEL_MIN * 60_000 + 60_000);
    r = await buildTripHealthProjection(makeClient(base()) as any, TRIP_ID, OWNER_ID, { now: leaveBy });
    assert.ok(r.ok); assert.equal(r.projection.phase.phase, "TRANSIT"); assert.equal(r.projection.phase.evidence.inTransitTo, "B");
  });
  it("refuses FEATURE_DISABLED when trip_operational_projections_enabled is off, naming the flag", async () => {
    const tables = base(); tables.feature_flags = [];
    const r = await buildTripHealthProjection(makeClient(tables) as any, TRIP_ID, OWNER_ID, { now: NOW });
    assert.ok(!r.ok && r.reason === "FEATURE_DISABLED");
    assert.match(r.message, /trip_operational_projections_enabled is off/);
  });
  it("every read that feeds it is refused when it fails — health over 'no risks' is HEALTHY by construction", async () => {
    for (const table of ["trips", "trip_commitments", "trip_risks", "safe_return_sessions", "trip_crew_location_preferences", "trip_plan_items"]) {
      const r = await buildTripHealthProjection(makeClient(base(), [table]) as any, TRIP_ID, OWNER_ID, { now: NOW });
      assert.ok(!r.ok && r.reason === "TRIP_PROJECTION_UNAVAILABLE", table);
    }
  });
});
