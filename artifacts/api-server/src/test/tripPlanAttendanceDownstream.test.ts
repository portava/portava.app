/**
 * Trips spec §5.1 / §8.4 — the plan ATTENDANCE relation (2771) used
 * downstream, not only stored (census-trips TR150).
 *
 * The row's last statement: "the impact preview's affected participants are
 * the plan's GOING / MAYBE attendance, not the crew; transport, budget and
 * the meeting point still take a stated party."
 *
 * What these tests pin, in the two places where the relation is now consulted:
 *
 *  1. §8.4's WEATHER trigger names WHO to tell. It fired with
 *     `participantIds: []` on every input, so the mitigation "move it indoors,
 *     tell the people affected" named nobody — the same shape §68.3 closed for
 *     the tight arrival, on the one object that actually HAS a participant
 *     relation. A member who declined the hike is not told about rain on it.
 *  2. §14.3's MEETING POINT can be asked for one PLAN's people. A meeting
 *     point for "the hike" was being computed for fourteen people, eleven of
 *     whom are not going.
 *
 * And two properties that are about honesty rather than about attendance:
 *
 *  3. A plan with NO attendance row falls back to the CREW, because 2771 is
 *     written when someone answers and silence on a crew-wide plan is the
 *     trip's default, not a declination.
 *  4. A plan named to the meeting point that is not on the trip is REFUSED,
 *     not quietly answered for the whole crew.
 *
 * Runtime: node:test + node:assert/strict. No network / no real DB.
 * Run: node --import tsx/esm --test src/test/tripPlanAttendanceDownstream.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateRiskTriggers, DEFAULT_VEHICLE_CAPACITY } from "../domain/trips/services/TripRiskTriggers.js";
import { computeMeetingPoint } from "../domain/trips/services/TripReplanService.js";
import type { PulseInterpretation } from "../domain/trips/projections/TripPulseProjection.js";

const NOW = Date.parse("2026-08-14T08:00:00.000Z");
const PLAN = "plan-hike";
const GOING_A = "u-anna";
const GOING_B = "u-ben";
const DECLINED = "u-cleo";

/** A rain signal that invalidates the hike, at a confidence above the §8.4 threshold. */
function rainOver(planId: string, confidence = 0.8): PulseInterpretation {
  return {
    kind: "rain_arriving",
    estimate: { confidence } as any,
    effects: [{ kind: "plan_invalidated", subjectIds: [planId] } as any],
  } as unknown as PulseInterpretation;
}

function triggersFor(opts: { participantIds?: string[]; crewSize?: number }) {
  return evaluateRiskTriggers({
    now: NOW,
    commitments: [],
    plans: [{
      id: PLAN, title: "Sintra hike", startsAt: "2026-08-14T14:00:00.000Z", endsAt: "2026-08-14T18:00:00.000Z",
      weatherSensitive: true, partySize: opts.participantIds?.length ?? null,
      ...(opts.participantIds === undefined ? {} : { participantIds: opts.participantIds }),
    }],
    transport: [],
    signals: [rainOver(PLAN)],
    crewSize: opts.crewSize ?? 3,
  });
}

describe("§8.4 weather trigger names the plan's attendance (TR150)", () => {
  it("fires naming the GOING / MAYBE attendance, and not the member who declined", () => {
    const t = triggersFor({ participantIds: [GOING_A, GOING_B] }).find((x) => x.kind === "weather_sensitive")!;
    assert.equal(t.fired, true);
    assert.deepEqual(t.affectedIds, [PLAN]);
    assert.deepEqual([...t.participantIds].sort(), [GOING_B, GOING_A].sort());
    assert.equal(t.participantIds.includes(DECLINED), false,
      "a member who declined the hike is not affected by rain on it");
  });

  it("names each person once when two weather-sensitive plans share an attendee", () => {
    const t = evaluateRiskTriggers({
      now: NOW,
      commitments: [],
      plans: [
        { id: "p1", title: "Hike", startsAt: "2026-08-14T14:00:00.000Z", endsAt: null, weatherSensitive: true, partySize: 2, participantIds: [GOING_A, GOING_B] },
        { id: "p2", title: "Picnic", startsAt: "2026-08-14T16:00:00.000Z", endsAt: null, weatherSensitive: true, partySize: 1, participantIds: [GOING_A] },
      ],
      transport: [],
      signals: [{ kind: "rain_arriving", estimate: { confidence: 0.9 } as any, effects: [{ kind: "plan_invalidated", subjectIds: ["p1", "p2"] } as any] } as unknown as PulseInterpretation],
      crewSize: 5,
    }).find((x) => x.kind === "weather_sensitive")!;
    assert.equal(t_sorted(t.participantIds).join(","), t_sorted([GOING_A, GOING_B]).join(","));
  });

  it("an UNREAD attendance contributes nobody here — the caller supplies the crew, this function does not invent it", () => {
    const t = triggersFor({ participantIds: undefined }).find((x) => x.kind === "weather_sensitive")!;
    assert.equal(t.fired, true, "the trigger still fires; only WHO is unknown");
    assert.deepEqual(t.participantIds, []);
  });

  it("does not name anyone when it does not fire", () => {
    const out = evaluateRiskTriggers({
      now: NOW, commitments: [],
      plans: [{ id: PLAN, title: "Museum", startsAt: "2026-08-14T14:00:00.000Z", endsAt: null, weatherSensitive: false, partySize: 2, participantIds: [GOING_A, GOING_B] }],
      transport: [], signals: [rainOver(PLAN)], crewSize: 3,
    }).find((x) => x.kind === "weather_sensitive")!;
    assert.equal(out.fired, false);
    assert.deepEqual(out.participantIds, []);
  });
});

function t_sorted(xs: string[]): string[] { return [...xs].sort(); }

describe("§8.4 crew transport mismatch measures the party it FILTERED on (TR150)", () => {
  /**
   * The filter consulted the served plan's party and the magnitude did not, so
   * a segment with no stated party that was CAUGHT by a nine-person plan was
   * REPORTED against the crew size. Two answers to one question, and the one
   * a reader sees was the wrong one.
   */
  it("reports the overflow against the served plan's attendance, not the crew size", () => {
    const out = evaluateRiskTriggers({
      now: NOW,
      commitments: [],
      plans: [{ id: PLAN, title: "Sintra hike", startsAt: "2026-08-14T14:00:00.000Z", endsAt: null, weatherSensitive: false, partySize: 9, participantIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }],
      // No stated party on the segment; it serves the nine-person plan.
      transport: [{ id: "seg-1", mode: "taxi", state: "planned", plannedDepartureAt: "2026-08-14T13:00:00.000Z", partySize: null, capacity: null, servesId: PLAN }],
      signals: [],
      crewSize: 5,
    }).find((x) => x.kind === "crew_transport_mismatch")!;
    assert.equal(out.fired, true);
    assert.equal(out.magnitude, 9 - DEFAULT_VEHICLE_CAPACITY.taxi,
      "the magnitude must come from the same party the filter used");
    assert.deepEqual(out.affectedIds, ["seg-1"]);
  });

  it("names the served plan's attendance as the people to tell", () => {
    const out = evaluateRiskTriggers({
      now: NOW,
      commitments: [],
      plans: [{ id: PLAN, title: "Sintra hike", startsAt: "2026-08-14T14:00:00.000Z", endsAt: null, weatherSensitive: false, partySize: 6, participantIds: [GOING_A, GOING_B, "c", "d", "e", "f"] }],
      transport: [{ id: "seg-1", mode: "taxi", state: "planned", plannedDepartureAt: "2026-08-14T13:00:00.000Z", partySize: 6, capacity: 4, servesId: PLAN }],
      signals: [],
      crewSize: 2,
    }).find((x) => x.kind === "crew_transport_mismatch")!;
    assert.equal(out.fired, true);
    assert.equal(out.participantIds.includes(GOING_A), true);
    assert.equal(out.participantIds.length, 6);
  });

  it("a segment that serves NO plan names nobody — 2782 gives a segment an integer, not people", () => {
    const out = evaluateRiskTriggers({
      now: NOW, commitments: [], plans: [],
      transport: [{ id: "seg-1", mode: "taxi", state: "planned", plannedDepartureAt: "2026-08-14T13:00:00.000Z", partySize: 9, capacity: 4, servesId: null }],
      signals: [], crewSize: 9,
    }).find((x) => x.kind === "crew_transport_mismatch")!;
    assert.equal(out.fired, true, "the mismatch is still reported");
    assert.deepEqual(out.participantIds, [], "and it is addressed to the segment, not to a guessed set of people");
  });
});

// ── §14.3 the meeting point, for ONE plan's people ───────────────────────────

const TRIP = "aaaaaaaa-0000-0000-0000-00000000aa01";
const CLEO = DECLINED;

/** Exactly the reads `loadImpactState` + `computeMeetingPoint` make. */
function meetingClient(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
        or: () => chain, gt: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (onF: any, onR: any) => Promise.resolve({ data: rows(), error: null }).then(onF, onR),
      };
      return chain;
    },
  };
}

function meetingTables(): Record<string, any[]> {
  return {
    // The gate this state loader sits behind, seeded in the FAKE only. No
    // deployment flag is touched by this file.
    feature_flags: [{ flag: "trip_operational_projections_enabled", enabled: true }],
    trips: [{ id: TRIP, version: 3, owner_id: GOING_A }],
    trip_members: [
      { trip_id: TRIP, user_id: GOING_A, status: "accepted" },
      { trip_id: TRIP, user_id: GOING_B, status: "accepted" },
      { trip_id: TRIP, user_id: CLEO, status: "accepted" },
    ],
    trip_plan_items: [{ id: PLAN, trip_id: TRIP, title: "Sintra hike", status: "planned", starts_at: "2026-08-14T14:00:00.000Z", ends_at: null, day_date: "2026-08-14", plan_scope: "ALL_CREW", lat: null, lng: null, location_is_private: true, place_id: null, location_name: null, removed_at: null }],
    trip_plan_participants: [
      { plan_id: PLAN, user_id: GOING_A, attendance_state: "going" },
      { plan_id: PLAN, user_id: GOING_B, attendance_state: "maybe" },
      { plan_id: PLAN, user_id: CLEO, attendance_state: "declined" },
    ],
    trip_reservations: [], trip_transport_segments: [], trip_commitments: [],
    safe_return_sessions: [], trip_saved_places: [],
  };
}

const MEETING_NOW = new Date("2026-08-14T08:00:00.000Z");
/** Nobody shares a position in these fixtures, so the UNPLACED list is exactly the party that was asked for. */
const partyOf = (r: any) => [...r.result.unplaced.map((u: any) => u.userId)].sort();

describe("§14.3 the meeting point takes a PLAN's attendance, not the whole crew (TR150)", () => {
  it("with no plan named, the party is the crew — unchanged", async () => {
    const r: any = await computeMeetingPoint(meetingClient(meetingTables()) as any, TRIP, GOING_A, { now: MEETING_NOW });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(partyOf(r), t_sorted([GOING_A, GOING_B, CLEO]));
  });

  it("naming the plan narrows the party to its GOING / MAYBE attendance", async () => {
    const r: any = await computeMeetingPoint(meetingClient(meetingTables()) as any, TRIP, GOING_A, { planId: PLAN, now: MEETING_NOW });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(partyOf(r), t_sorted([GOING_A, GOING_B]),
      "the member who declined the hike is not asked to meet for it");
  });

  it("a plan that is not on this trip is REFUSED, never answered for the whole crew", async () => {
    const r: any = await computeMeetingPoint(meetingClient(meetingTables()) as any, TRIP, GOING_A, { planId: "plan-not-here", now: MEETING_NOW });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "TRIP_PLAN_NOT_FOUND",
      "a fourteen-person answer to a one-plan question is a confident wrong answer");
  });

  it("an explicit participant list still wins over the plan", async () => {
    const r: any = await computeMeetingPoint(meetingClient(meetingTables()) as any, TRIP, GOING_A, { planId: PLAN, participantIds: [CLEO], now: MEETING_NOW });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(partyOf(r), [CLEO]);
  });
});
