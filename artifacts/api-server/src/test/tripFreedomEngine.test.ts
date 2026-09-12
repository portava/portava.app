/**
 * Trips spec §7.3 — the Temporal Freedom Engine, pure; §7.2's conflict rule;
 * §22.4's property. census-trips TR129-TR132, TR395, TR412.
 *
 * Every window is a LOWER BOUND on free time. The tests pin the arithmetic
 * that makes it one (the window begins no earlier than the latest allowed
 * arrival at the previous commitment; it ends when the traveller must leave,
 * against a lower-bound travel term; unknown travel is never zero), the
 * constraints and confidence a consumer reads, the two conflict kinds, and
 * then §22.4 as a property driven with the REAL straight-line provider over
 * seeded random itineraries: an earlier hard commitment never increases the
 * free time before the commitment it precedes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeFreedomWindows, detectPlanOverlaps, leaveAt, orderCommitments,
  HARD_CONSTRAINT_KINDS, TEMPORAL_CONFLICT_KINDS,
  type EngineCommitment, type HopTravel,
} from "../services/trips/TripFreedomEngine.js";
import { checkFeasibility } from "../services/trips/TripFeasibilityEngine.js";
import { straightLineTravelTimeProvider, type GeoPoint } from "../services/trips/TravelTimeProvider.js";

const T = (hhmm: string, day = "13") => new Date(`2026-09-${day}T${hhmm}:00.000Z`);
const P: GeoPoint = { lat: 48.8566, lng: 2.3522 };
const Q: GeoPoint = { lat: 48.9, lng: 2.4 };

function c(id: string, o: Partial<EngineCommitment> = {}): EngineCommitment {
  return {
    id, type: "event", startsAt: null, requiredArrivalAt: null, endsAt: null,
    place: { placeId: `place-${id}`, point: P }, flexibility: "flexible", prepMinutes: 0, latenessToleranceMinutes: 0, ...o,
  };
}
const hop = (travelMinutes: number | null, o: Partial<HopTravel> = {}): HopTravel =>
  ({ travelMinutes, confidence: travelMinutes === null ? "INSUFFICIENT" : "LOW", routed: false, unknownReason: travelMinutes === null ? "NO_COORDINATES" : null, ...o });
const run = (commitments: EngineCommitment[], hops: HopTravel[], bounds: { tripStart?: Date | null; tripEnd?: Date | null } = {}) =>
  computeFreedomWindows({ commitments, hops, participants: ["u1", "u2"], tripStart: bounds.tripStart ?? null, tripEnd: bounds.tripEnd ?? null });

describe("§7.3 a window between two commitments", () => {
  it("begins when the previous releases the traveller and ends when they must leave: deadline + tolerance − travel − prep", () => {
    const A = c("A", { startsAt: T("10:00"), place: { placeId: "pA", point: P } });
    const B = c("B", { requiredArrivalAt: T("14:00"), startsAt: T("14:30"), prepMinutes: 10, place: { placeId: "pB", point: Q } });
    const r = run([A, B], [hop(30)]);
    assert.equal(r.conflicts.length, 0);
    assert.equal(r.windows.length, 1);
    const w = r.windows[0]!;
    assert.equal(w.position, "between");
    assert.equal(w.beginsAt, T("10:00").toISOString());
    assert.equal(w.endsAt, T("13:20").toISOString(), "14:00 − 30 travel − 10 prep");
    assert.equal(w.durationMinutes, 200);
    assert.equal(w.reservedMinutes, 40);
    assert.deepEqual(w.origin, { placeId: "pA", point: P });
    assert.deepEqual(w.requiredDestination, { placeId: "pB", point: Q, commitmentId: "B", arriveBy: T("14:00").toISOString() });
    assert.deepEqual(w.participants, ["u1", "u2"]);
    assert.deepEqual(w.hardConstraints.map((h) => h.kind), ["PREVIOUS_END_UNKNOWN"], "trip_commitments has no end column and the window says so");
    assert.equal(w.confidence, "LOW");
    assert.equal(w.certified, false);
    assert.equal(w.id, "fw:A:B");
    assert.deepEqual(w.afterCommitmentId, "A"); assert.deepEqual(w.beforeCommitmentId, "B");
  });

  it("lateness tolerance extends the end; a known previous end moves the start", () => {
    const A = c("A", { startsAt: T("10:00"), endsAt: T("11:00"), latenessToleranceMinutes: 15 });
    const B = c("B", { requiredArrivalAt: T("14:00"), latenessToleranceMinutes: 20, prepMinutes: 10 });
    const w = run([A, B], [hop(30)]).windows[0]!;
    assert.equal(w.beginsAt, T("11:00").toISOString());
    assert.equal(w.endsAt, T("13:40").toISOString(), "14:20 − 40");
    assert.ok(!w.hardConstraints.some((h) => h.kind === "PREVIOUS_END_UNKNOWN"));
  });

  it("never begins before the latest moment the traveller was allowed to ARRIVE at the previous commitment", () => {
    // A zero-duration commitment with a 30-minute tolerance: you might arrive
    // at 10:30, so you are not free at 10:00. The window begins at 10:30.
    const A = c("A", { requiredArrivalAt: T("10:00"), startsAt: T("10:00"), endsAt: T("10:00"), latenessToleranceMinutes: 30 });
    assert.equal(leaveAt(A)!.toISOString(), T("10:30").toISOString());
    const B = c("B", { requiredArrivalAt: T("12:00") });
    assert.equal(run([A, B], [hop(10)]).windows[0]!.beginsAt, T("10:30").toISOString());
  });

  it("an unknown travel term is NOT zero: the end is the deadline less prep, flagged TRAVEL_UNKNOWN, graded INSUFFICIENT, never certified", () => {
    const A = c("A", { startsAt: T("10:00"), place: { placeId: null, point: null } });
    const B = c("B", { requiredArrivalAt: T("14:00"), prepMinutes: 10 });
    const w = run([A, B], [hop(null)]).windows[0]!;
    assert.equal(w.endsAt, T("13:50").toISOString());
    assert.equal(w.reservedMinutes, null);
    assert.equal(w.confidence, "INSUFFICIENT");
    assert.equal(w.certified, false);
    assert.deepEqual(w.hardConstraints.map((h) => h.kind).sort(), ["NO_ORIGIN", "PREVIOUS_END_UNKNOWN", "TRAVEL_UNKNOWN"]);
  });

  it("names a fixed destination and an assumed deadline, and downgrades confidence for the assumption", () => {
    const A = c("A", { startsAt: T("10:00"), endsAt: T("11:00") });
    const B = c("B", { startsAt: T("14:00"), flexibility: "fixed" });
    const w = run([A, B], [hop(30, { confidence: "HIGH", routed: true })]).windows[0]!;
    assert.deepEqual(w.hardConstraints.map((h) => h.kind).sort(), ["ARRIVAL_DEADLINE_ASSUMED_FROM_START", "NEXT_IS_FIXED"]);
    assert.equal(w.confidence, "LOW", "an assumed deadline caps the confidence even on a routed hop");
    assert.equal(w.certified, false);
  });

  it("certified requires HIGH confidence with no unknown term — which needs a routed provider and a known previous end", () => {
    const A = c("A", { startsAt: T("10:00"), endsAt: T("11:00") });
    const B = c("B", { requiredArrivalAt: T("14:00") });
    const w = run([A, B], [hop(30, { confidence: "HIGH", routed: true })]).windows[0]!;
    assert.equal(w.confidence, "HIGH");
    assert.equal(w.certified, true, "the field is computed, so a routed provider would light it");
    const lower = run([A, B], [hop(30)]).windows[0]!;
    assert.equal(lower.certified, false, "the straight-line provider reports LOW; nothing is certified today");
  });
});

describe("§7.2 conflicts are returned, not dropped", () => {
  it("OVERLAP: the next deadline (with tolerance) is before the traveller is released", () => {
    const A = c("A", { startsAt: T("10:00"), endsAt: T("11:00") });
    const B = c("B", { requiredArrivalAt: T("10:30"), latenessToleranceMinutes: 10 });
    const r = run([A, B], [hop(5)]);
    assert.equal(r.windows.length, 0);
    assert.equal(r.conflicts.length, 1);
    const k = r.conflicts[0]!;
    assert.equal(k.reason, "TRIP_TEMPORAL_CONFLICT");
    assert.equal(k.kind, "OVERLAP");
    assert.deepEqual(k.commitmentIds, ["A", "B"]);
    assert.equal(k.shortfallMinutes, 20, "11:00 − 10:40");
    assert.equal(k.overridden, false, "no override path exists; the type says so");
  });

  it("NO_TIME_TO_TRAVEL: time exists but travel + prep eat all of it, with the shortfall", () => {
    const A = c("A", { startsAt: T("10:00") });
    const B = c("B", { requiredArrivalAt: T("10:30"), prepMinutes: 5 });
    const r = run([A, B], [hop(45)]);
    assert.equal(r.windows.length, 0);
    assert.equal(r.conflicts[0]!.kind, "NO_TIME_TO_TRAVEL");
    assert.equal(r.conflicts[0]!.shortfallMinutes, 20, "50 needed, 30 available");
    assert.match(r.conflicts[0]!.detail, /lower bound/);
  });

  it("the kinds and constraint kinds are closed vocabularies", () => {
    assert.deepEqual([...TEMPORAL_CONFLICT_KINDS], ["OVERLAP", "NO_TIME_TO_TRAVEL", "PLAN_OVERLAP"]);
    assert.equal(HARD_CONSTRAINT_KINDS.length, 6);
  });
});

describe("the ends of the trip, ordering, and the unplaceable", () => {
  it("emits a before_first window from the trip start and an after_last window to the trip end, each saying what it lacks", () => {
    const A = c("A", { requiredArrivalAt: T("10:00"), startsAt: T("10:00"), prepMinutes: 10 });
    const B = c("B", { requiredArrivalAt: T("14:00"), startsAt: T("14:30") });
    const r = run([A, B], [hop(30)], { tripStart: T("00:00"), tripEnd: T("23:59") });
    assert.deepEqual(r.windows.map((w) => w.position), ["before_first", "between", "after_last"]);
    const first = r.windows[0]!; const last = r.windows[2]!;
    assert.equal(first.endsAt, T("09:50").toISOString());
    assert.equal(first.confidence, "INSUFFICIENT");
    assert.deepEqual(first.hardConstraints.map((h) => h.kind), ["NO_ORIGIN", "TRAVEL_UNKNOWN"]);
    assert.equal(first.origin, null);
    assert.equal(last.beginsAt, T("14:30").toISOString(), "leaves B at its start (no end known)");
    assert.equal(last.requiredDestination, null);
    assert.deepEqual(last.hardConstraints.map((h) => h.kind), ["NO_DESTINATION", "PREVIOUS_END_UNKNOWN"]);
    assert.equal(last.id, "fw:B:end");
  });

  it("orders by deadline whatever the input order, and sets aside commitments with no time at all", () => {
    const late = c("late", { startsAt: T("18:00") });
    const early = c("early", { startsAt: T("09:00") });
    const nowhere = c("nowhere");
    const { ordered, unplaced } = orderCommitments([late, nowhere, early]);
    assert.deepEqual(ordered.map((x) => x.id), ["early", "late"]);
    assert.deepEqual(unplaced, ["nowhere"]);
    const r = run([late, nowhere, early], [hop(10)]);
    assert.deepEqual(r.unplacedCommitmentIds, ["nowhere"]);
    assert.equal(r.windows[0]!.afterCommitmentId, "early");
  });

  it("refuses a hop list that does not match the placed commitments — a silent misalignment would put travel on the wrong gap", () => {
    assert.throws(() => run([c("A", { startsAt: T("09:00") }), c("B", { startsAt: T("10:00") })], []), /need 1 hop/);
  });
});

describe("§7.2 on the plan: overlapping items on a day", () => {
  const item = (id: string, s: string, e: string | null, day = "2026-09-13") => ({ id, dayDate: day, startsAt: s ? T(s).toISOString() : null, endsAt: e ? T(e).toISOString() : null });
  it("flags adjacent overlaps on the same day with the overlap in minutes; a chain of three yields two", () => {
    const out = detectPlanOverlaps([item("a", "10:00", "12:00"), item("b", "11:30", "13:00"), item("c", "12:45", "14:00")]);
    assert.deepEqual(out.map((k) => [k.kind, k.planIds, k.shortfallMinutes]), [["PLAN_OVERLAP", ["a", "b"], 30], ["PLAN_OVERLAP", ["b", "c"], 15]]);
    assert.ok(out.every((k) => k.reason === "TRIP_TEMPORAL_CONFLICT" && k.overridden === false));
  });
  it("does not judge items without both times, items on different days, or items that merely touch", () => {
    assert.deepEqual(detectPlanOverlaps([item("a", "10:00", null), item("b", "10:30", "11:00")]), []);
    assert.deepEqual(detectPlanOverlaps([item("a", "10:00", "12:00"), item("b", "11:00", "12:00", "2026-09-14")]), []);
    assert.deepEqual(detectPlanOverlaps([item("a", "10:00", "11:00"), item("b", "11:00", "12:00")]), []);
  });
});

describe("§22.4 an earlier hard commitment cannot increase the preceding free window — with the real provider", () => {
  // Seeded LCG so a failure is reproducible.
  let seed = 20260913;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const point = (): GeoPoint => ({ lat: 48.80 + rnd() * 0.12, lng: 2.25 + rnd() * 0.2 });
  const minutes = (ms: number) => ms / 60_000;

  async function hopsFor(list: EngineCommitment[]): Promise<HopTravel[]> {
    const placed = orderCommitments(list).ordered;
    const hops: HopTravel[] = [];
    for (let i = 1; i < placed.length; i += 1) {
      const prev = placed[i - 1]!; const next = placed[i]!;
      const r = await checkFeasibility(straightLineTravelTimeProvider, { departFrom: prev.endsAt ?? prev.startsAt!, fromPlace: prev.place.point }, {
        toPlace: next.place.point, requiredArrivalAt: next.requiredArrivalAt, startsAt: next.startsAt,
        prepMinutes: next.prepMinutes, latenessToleranceMinutes: next.latenessToleranceMinutes,
      });
      hops.push({ travelMinutes: r.travelMinutes, confidence: r.confidence, routed: r.routed, unknownReason: r.unknownReason });
    }
    return hops;
  }
  const freeBetween = (windows: ReturnType<typeof computeFreedomWindows>["windows"], after: Set<string>, before: Set<string>) =>
    windows.filter((w) => w.position === "between" && after.has(w.afterCommitmentId!) && before.has(w.beforeCommitmentId!))
      .reduce((s, w) => s + (Date.parse(w.endsAt) - Date.parse(w.beginsAt)), 0);

  it("holds over 60 seeded itineraries: inserting a fixed commitment X between prev and N never grows the free time between prev and N unless it is a marked conflict", async () => {
    let checked = 0;
    for (let round = 0; round < 60; round += 1) {
      const n = 3 + Math.floor(rnd() * 3);
      const list: EngineCommitment[] = [];
      let t = 8 * 60 + Math.floor(rnd() * 60);
      for (let i = 0; i < n; i += 1) {
        const start = new Date(Date.UTC(2026, 8, 13, 0, t));
        const dur = 30 + Math.floor(rnd() * 90);
        list.push(c(`c${i}`, {
          requiredArrivalAt: start, startsAt: start, endsAt: rnd() < 0.5 ? new Date(start.getTime() + dur * 60_000) : null,
          place: { placeId: `p${i}`, point: point() }, prepMinutes: Math.floor(rnd() * 20), latenessToleranceMinutes: Math.floor(rnd() * 15),
          flexibility: rnd() < 0.5 ? "fixed" : "flexible",
        }));
        t += dur + 60 + Math.floor(rnd() * 180);
      }
      const before = computeFreedomWindows({ commitments: list, hops: await hopsFor(list), participants: [], tripStart: null, tripEnd: null });
      const between = before.windows.filter((w) => w.position === "between");
      if (between.length === 0) continue;
      const w = between[Math.floor(rnd() * between.length)]!;
      const prevId = w.afterCommitmentId!; const nextId = w.beforeCommitmentId!;
      const span = Date.parse(w.endsAt) - Date.parse(w.beginsAt);
      const at = new Date(Date.parse(w.beginsAt) + Math.floor(rnd() * span));
      const X = c("X", {
        requiredArrivalAt: at, startsAt: at, endsAt: rnd() < 0.5 ? new Date(at.getTime() + Math.floor(rnd() * 40) * 60_000) : null,
        place: { placeId: "pX", point: point() }, prepMinutes: Math.floor(rnd() * 20), latenessToleranceMinutes: Math.floor(rnd() * 15),
        flexibility: "fixed",
      });
      const withX = [...list, X];
      const after = computeFreedomWindows({ commitments: withX, hops: await hopsFor(withX), participants: [], tripStart: null, tripEnd: null });
      const oldFree = freeBetween(before.windows, new Set([prevId]), new Set([nextId]));
      const newFree = freeBetween(after.windows, new Set([prevId, "X"]), new Set(["X", nextId]));
      // §7.2 first: an X that cannot be reached, or that N cannot be reached
      // from, is a CONFLICT and the timeline is no longer consistent — the
      // window after X is then computed from a schedule that cannot happen,
      // and the invariant is about consistent timelines. So: either the
      // insertion is marked as a conflict, or it did not buy free time.
      const conflicted = after.conflicts.some((k) => k.commitmentIds.includes("X"));
      assert.ok(conflicted || newFree <= oldFree,
        `round ${round}: no conflict, yet free time grew from ${minutes(oldFree)} to ${minutes(newFree)} minutes after inserting X at ${at.toISOString()}`);
      if (!conflicted) checked += 1;
    }
    assert.ok(checked >= 25, `only ${checked} conflict-free rounds exercised the property`);
  });
});
