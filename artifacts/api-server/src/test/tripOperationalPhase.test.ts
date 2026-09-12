/**
 * Trips spec §3.2 — the active operational phase, derived; §17.1 — trip
 * health as a summary over concrete reasons. census-trips TR38–TR45, TR314,
 * TR317. Both PURE: the clauses, their order, and that every answer carries
 * the clause that produced it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveOperationalPhase, localClock, OPERATIONAL_PHASES, PRIMARY_FOCUS, type PhaseInputs,
} from "../services/trips/TripOperationalPhase.js";
import { deriveTripHealth, surfacePriority, TRIP_HEALTH_LEVELS, HEALTH_REASON_CODES } from "../services/trips/TripHealth.js";
import type { FreedomWindow } from "../services/trips/TripFreedomEngine.js";

const at = (iso: string) => new Date(iso);
const base = (o: Partial<PhaseInputs> = {}): PhaseInputs => ({
  now: at("2026-09-13T14:00:00Z"), timezone: "Europe/Lisbon", tripStartDate: "2026-09-12", tripEndDate: "2026-09-15",
  tripStatus: "active", planItems: [], windows: [], disrupted: false, safeReturnActive: false, ...o,
});
const window = (o: Partial<FreedomWindow> = {}): FreedomWindow => ({
  id: "fw:A:B", position: "between", beginsAt: "2026-09-13T10:00:00Z", endsAt: "2026-09-13T15:00:00Z", durationMinutes: 300,
  origin: null, requiredDestination: { placeId: null, point: null, commitmentId: "B", arriveBy: "2026-09-13T16:00:00Z" },
  participants: [], hardConstraints: [], confidence: "LOW", certified: false, reservedMinutes: 60, afterCommitmentId: "A", beforeCommitmentId: "B", ...o,
});

describe("§3.2 the phase, clause by clause, in order", () => {
  it("names all eight phases and §3.2's primary focus for each", () => {
    assert.equal(OPERATIONAL_PHASES.length, 8);
    for (const p of OPERATIONAL_PHASES) assert.ok(PRIMARY_FOCUS[p].length > 10, p);
    const d = deriveOperationalPhase(base());
    assert.equal(d.primaryFocus, PRIMARY_FOCUS[d.phase!]);
  });
  it("no phase outside the trip's dates or on a cancelled trip — a trip that has not started is not in FREE_TIME", () => {
    assert.equal(deriveOperationalPhase(base({ now: at("2026-09-01T12:00:00Z") })).phase, null);
    assert.equal(deriveOperationalPhase(base({ now: at("2026-09-20T12:00:00Z") })).phase, null);
    assert.equal(deriveOperationalPhase(base({ tripStatus: "cancelled" })).phase, null);
    assert.equal(deriveOperationalPhase(base({ tripStartDate: null })).phase, null);
    assert.match(deriveOperationalPhase(base({ now: at("2026-09-01T12:00:00Z") })).reason, /outside/);
  });
  it("DISRUPTED first, whatever else is true", () => {
    const d = deriveOperationalPhase(base({ disrupted: true, now: at("2026-09-12T10:00:00Z"), windows: [window()] }));
    assert.equal(d.phase, "DISRUPTED");
  });
  it("the trip's edges own their days: ARRIVAL_DAY, DEPARTURE_DAY, and a one-day trip splits at local noon", () => {
    assert.equal(deriveOperationalPhase(base({ now: at("2026-09-12T10:00:00Z"), windows: [window({ beginsAt: "2026-09-12T09:00:00Z", endsAt: "2026-09-12T11:00:00Z" })] })).phase, "ARRIVAL_DAY");
    assert.equal(deriveOperationalPhase(base({ now: at("2026-09-15T10:00:00Z") })).phase, "DEPARTURE_DAY");
    const oneDay = { tripStartDate: "2026-09-13", tripEndDate: "2026-09-13" };
    assert.equal(deriveOperationalPhase(base({ ...oneDay, now: at("2026-09-13T08:00:00Z") })).phase, "ARRIVAL_DAY");
    assert.equal(deriveOperationalPhase(base({ ...oneDay, now: at("2026-09-13T15:00:00Z") })).phase, "DEPARTURE_DAY");
  });
  it("TRANSIT between a window's leave-by and the next commitment's arrival; then ACTIVE_PLAN for an item under way", () => {
    const t = deriveOperationalPhase(base({ now: at("2026-09-13T15:30:00Z"), windows: [window()] }));
    assert.equal(t.phase, "TRANSIT");
    assert.equal(t.evidence.inTransitTo, "B");
    const a = deriveOperationalPhase(base({ planItems: [{ id: "p1", category: "activity", status: "confirmed", startsAt: "2026-09-13T13:00:00Z", endsAt: "2026-09-13T15:00:00Z", dayDate: "2026-09-13" }] }));
    assert.equal(a.phase, "ACTIVE_PLAN");
    assert.equal(a.evidence.activePlanId, "p1");
    const cancelled = deriveOperationalPhase(base({ planItems: [{ id: "p1", category: "activity", status: "cancelled", startsAt: "2026-09-13T13:00:00Z", endsAt: "2026-09-13T15:00:00Z", dayDate: "2026-09-13" }] }));
    assert.notEqual(cancelled.phase, "ACTIVE_PLAN");
    const inProgress = deriveOperationalPhase(base({ planItems: [{ id: "p2", category: "activity", status: "in_progress", startsAt: null, endsAt: null, dayDate: "2026-09-13" }] }));
    assert.equal(inProgress.phase, "ACTIVE_PLAN", "an explicit IN_PROGRESS state, when the kernel has one, is honoured");
  });
  it("the clock: NIGHTLIFE needs a reason (safe return or a nightlife plan today), else REST in rest hours, else FREE_TIME", () => {
    // 23:00 Lisbon = 22:00Z in September (WEST).
    const night = at("2026-09-13T22:00:00Z");
    assert.equal(deriveOperationalPhase(base({ now: night })).phase, "FREE_TIME", "night with nothing planned and no safe return is not NIGHTLIFE");
    assert.equal(deriveOperationalPhase(base({ now: night, safeReturnActive: true })).phase, "NIGHTLIFE");
    assert.equal(deriveOperationalPhase(base({ now: night, planItems: [{ id: "d", category: "dining", status: "confirmed", startsAt: null, endsAt: null, dayDate: "2026-09-13" }] })).phase, "NIGHTLIFE");
    // 04:00 Lisbon = 03:00Z: rest hours, night hours over.
    assert.equal(deriveOperationalPhase(base({ now: at("2026-09-13T03:00:00Z") })).phase, "REST");
    // 01:00 Lisbon = 00:00Z: still night AND rest; a safe return makes it NIGHTLIFE.
    assert.equal(deriveOperationalPhase(base({ now: at("2026-09-13T00:00:00Z"), safeReturnActive: true })).phase, "NIGHTLIFE");
    assert.equal(deriveOperationalPhase(base({ now: at("2026-09-13T00:00:00Z") })).phase, "REST");
  });
  it("FREE_TIME inside a window names the window; with no window it says nothing bounds the moment", () => {
    const w = deriveOperationalPhase(base({ now: at("2026-09-13T12:00:00Z"), windows: [window()] }));
    assert.equal(w.phase, "FREE_TIME"); assert.equal(w.evidence.windowId, "fw:A:B");
    const none = deriveOperationalPhase(base());
    assert.equal(none.phase, "FREE_TIME"); assert.match(none.reason, /no commitment bounds/);
  });
  it("judges the clock in the trip's zone, and falls back to UTC on an unknown zone", () => {
    assert.deepEqual(localClock(at("2026-09-13T23:30:00Z"), "Asia/Tokyo"), { date: "2026-09-14", hour: 8 });
    assert.deepEqual(localClock(at("2026-09-13T23:30:00Z"), "Not/AZone"), { date: "2026-09-13", hour: 23 });
    assert.equal(localClock(at("2026-09-13T00:10:00Z"), "UTC").hour, 0, "midnight is 0, not 24");
  });
});

describe("§17.1 health is the worst concrete reason, and never a word alone", () => {
  const conflict = { reason: "TRIP_TEMPORAL_CONFLICT" as const, kind: "OVERLAP" as const, commitmentIds: ["A", "B"], planIds: [], shortfallMinutes: 5, overridden: false as const, detail: "x" };
  it("HEALTHY with nothing, and carries the ladder", () => {
    const h = deriveTripHealth({ conflicts: [], risks: [], needsHelpMemberIds: [], hops: { infeasible: 0, unknown: 0 } });
    assert.equal(h.health, "HEALTHY"); assert.deepEqual(h.reasons, []); assert.deepEqual([...h.ladder], [...TRIP_HEALTH_LEVELS]);
    assert.deepEqual(surfacePriority("HEALTHY"), []);
  });
  it("ATTENTION: an elevated open risk or an unjudgeable hop (unknown is not safe)", () => {
    assert.equal(deriveTripHealth({ conflicts: [], risks: [{ id: "r", likelihood: "high", impact: "low", status: "open" }], needsHelpMemberIds: [], hops: { infeasible: 0, unknown: 0 } }).health, "ATTENTION");
    const h = deriveTripHealth({ conflicts: [], risks: [], needsHelpMemberIds: [], hops: { infeasible: 0, unknown: 2 } });
    assert.equal(h.health, "ATTENTION"); assert.equal(h.reasons[0]!.code, "FEASIBILITY_UNKNOWN");
  });
  it("AT_RISK: a conflict, a high/high open risk, or an infeasible hop — and the §17.2 priority appears", () => {
    const h = deriveTripHealth({ conflicts: [conflict], risks: [], needsHelpMemberIds: [], hops: { infeasible: 1, unknown: 0 } });
    assert.equal(h.health, "AT_RISK");
    assert.deepEqual(h.reasons.map((r) => r.code).sort(), ["FEASIBILITY_INFEASIBLE", "TRIP_TEMPORAL_CONFLICT"]);
    assert.deepEqual(h.reasons.find((r) => r.code === "TRIP_TEMPORAL_CONFLICT")!.subjectIds, ["A", "B"]);
    assert.equal(deriveTripHealth({ conflicts: [], risks: [{ id: "r", likelihood: "high", impact: "high", status: "open" }], needsHelpMemberIds: [], hops: { infeasible: 0, unknown: 0 } }).health, "AT_RISK");
    assert.deepEqual([...surfacePriority("AT_RISK")], ["logistics", "affected_commitments", "recovery"]);
  });
  it("DISRUPTED: a realised risk or a NEEDS_HELP member, ranked above everything and listed first", () => {
    const h = deriveTripHealth({ conflicts: [conflict], risks: [{ id: "r", likelihood: "low", impact: "low", status: "realised" }], needsHelpMemberIds: ["u9"], hops: { infeasible: 0, unknown: 1 } });
    assert.equal(h.health, "DISRUPTED");
    assert.deepEqual(h.reasons.slice(0, 2).map((r) => r.code).sort(), ["SAFETY_NEEDS_HELP", "TRIP_RISK_REALISED"]);
    assert.equal(h.reasons.length, 4, "the summary does not replace the reasons: every one is still there");
  });
  it("closed and mitigated risks are not reasons; the code vocabulary is closed", () => {
    const h = deriveTripHealth({ conflicts: [], risks: [{ id: "r", likelihood: "high", impact: "high", status: "mitigated" }, { id: "s", likelihood: "high", impact: "high", status: "closed" }], needsHelpMemberIds: [], hops: { infeasible: 0, unknown: 0 } });
    assert.equal(h.health, "HEALTHY");
    assert.equal(HEALTH_REASON_CODES.length, 8);
    assert.ok(HEALTH_REASON_CODES.includes("TRIP_DISRUPTION_ACTIVE"), "§17.2 (2785): an active disruption is a health reason");
  });
});
