/**
 * Appendix B TRIP_TEMPORAL_INFEASIBLE / TRIP_TEMPORAL_UNKNOWN, emitted
 * (census-trips TR443). §12.1's simulation verdict carried a feasibility word;
 * it carries the reason code beside it now — INFEASIBLE when a commitment's
 * approach window refuses the change, UNKNOWN when no slot was given to judge,
 * null when feasible — so a client and Compass act on the vocabulary, not on
 * a label.
 *
 * Run: node --import tsx/esm --test src/test/tripSimulateReasonCodes.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { simulateChange } from "../services/trips/TripReplan.js";
import type { ImpactState } from "../services/trips/TripImpactPreview.js";
import { TRIP_REASON_CODES } from "../lib/tripReasonCodes.js";

const T = (hhmm: string) => `2026-09-13T${hhmm}:00.000Z`;
const NOW = Date.parse(T("12:00"));
const state: ImpactState = {
  plans: [{ id: "walk", title: "Walk", status: "confirmed", startsAt: T("15:00"), endsAt: T("16:00"), dayDate: "2026-09-13", participantIds: ["me"], planScope: "SOLO", confirmed: true }],
  reservations: [], transport: [],
  commitments: [{ id: "train", type: "train", startsAt: T("18:00"), requiredArrivalAt: T("18:00"), flexibility: "fixed", participantIds: ["me"] }],
  safeReturnActiveFor: [], crewIds: ["me"],
};

describe("TR443 — the simulation verdict names its temporal reason", () => {
  it("a move into the train's approach window is INFEASIBLE with TRIP_TEMPORAL_INFEASIBLE and the conflict", () => {
    const v = simulateChange({ kind: "move_plan", targetId: "walk", startsAt: T("17:45"), endsAt: T("18:45") }, state, [], NOW);
    assert.equal(v.feasibility, "INFEASIBLE"); assert.equal(v.reasonCode, "TRIP_TEMPORAL_INFEASIBLE");
    assert.ok(v.conflicts.length >= 1);
  });
  it("a move with no slot given cannot be judged: UNKNOWN with TRIP_TEMPORAL_UNKNOWN", () => {
    const v = simulateChange({ kind: "move_plan", targetId: "walk" }, state, [], NOW);
    assert.equal(v.feasibility, "UNKNOWN"); assert.equal(v.reasonCode, "TRIP_TEMPORAL_UNKNOWN");
  });
  it("a move clear of every commitment is FEASIBLE with no reason code", () => {
    const v = simulateChange({ kind: "move_plan", targetId: "walk", startsAt: T("13:00"), endsAt: T("14:00") }, state, [], NOW);
    assert.equal(v.feasibility, "FEASIBLE"); assert.equal(v.reasonCode, null);
  });
  it("both codes are Appendix B's", () => {
    for (const c of ["TRIP_TEMPORAL_INFEASIBLE", "TRIP_TEMPORAL_UNKNOWN"]) assert.ok((TRIP_REASON_CODES as readonly string[]).includes(c), c);
  });
});
