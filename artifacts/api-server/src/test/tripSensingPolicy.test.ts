/**
 * Trips spec §10.3 — sensing frequency rises only when execution or safety
 * requires it (census-trips TR172). Pure rule; the Today projection publishes it.
 *
 * Run: node --import tsx/esm --test src/test/tripSensingPolicy.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideSensing, SENSING_INTERVAL_SECONDS, EXECUTION_LEAD_MINUTES } from "../lib/tripSensingPolicy.js";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const base = { phase: "FREE_TIME" as const, attentionMode: "NORMAL" as const, mustLeaveBy: null, safeReturnActive: 0, now: NOW };

describe("TR172 — sensing frequency", () => {
  it("idle when nothing is executing and nobody is at risk: fifteen minutes, no reasons", () => {
    const p = decideSensing(base);
    assert.equal(p.level, "idle"); assert.equal(p.intervalSeconds, 15 * 60); assert.deepEqual(p.reasons, []);
  });
  it("execution when a plan is active, the leave-by is within the hour, in transit, disrupted, or at risk: two minutes", () => {
    assert.deepEqual(decideSensing({ ...base, phase: "ACTIVE_PLAN" }).reasons, ["PLAN_IN_PROGRESS"]);
    assert.deepEqual(decideSensing({ ...base, phase: "DISRUPTED" }).reasons, ["DISRUPTED"]);
    assert.deepEqual(decideSensing({ ...base, attentionMode: "AT_RISK" }).reasons, ["AT_RISK_MODE"]);
    assert.equal(decideSensing({ ...base, phase: "ACTIVE_PLAN" }).level, "execution");
    const soon = decideSensing({ ...base, mustLeaveBy: new Date(NOW + 45 * 60_000).toISOString() });
    assert.equal(soon.level, "execution"); assert.deepEqual(soon.reasons, ["LEAVE_BY_WITHIN_HOUR"]); assert.equal(soon.intervalSeconds, 120);
    assert.equal(decideSensing({ ...base, mustLeaveBy: new Date(NOW + (EXECUTION_LEAD_MINUTES + 5) * 60_000).toISOString() }).level, "idle", "a leave-by further out does not");
    assert.equal(decideSensing({ ...base, phase: "TRANSIT" }).level, "execution");
  });
  it("safety when a Safe Return is active or the trip is in SAFETY_EVENT mode: thirty seconds, and it outranks execution", () => {
    const sr = decideSensing({ ...base, safeReturnActive: 1, phase: "ACTIVE_PLAN" });
    assert.equal(sr.level, "safety"); assert.equal(sr.intervalSeconds, 30);
    assert.deepEqual(sr.reasons, ["SAFE_RETURN_ACTIVE", "PLAN_IN_PROGRESS"], "every reason that applied is listed");
    assert.equal(decideSensing({ ...base, attentionMode: "SAFETY_EVENT" }).level, "safety");
  });
  it("a safe-return count that was not read (null) is not a safety event", () => {
    assert.equal(decideSensing({ ...base, safeReturnActive: null }).level, "idle");
    assert.equal(decideSensing({ ...base, phase: null }).level, "idle", "no phase: the trip is not in progress today");
    for (const phase of ["ARRIVAL_DAY", "NIGHTLIFE", "REST", "DEPARTURE_DAY"] as const) assert.equal(decideSensing({ ...base, phase }).level, "idle", phase);
  });
  it("the intervals are the spec's shape: idle > execution > safety", () => {
    assert.ok(SENSING_INTERVAL_SECONDS.idle > SENSING_INTERVAL_SECONDS.execution && SENSING_INTERVAL_SECONDS.execution > SENSING_INTERVAL_SECONDS.safety);
  });
});
