/**
 * IG §19 Neighborhood Pulse aggregation (Table 28 thresholded aggregate).
 *
 * Proves: the pulse is a per-subject-deduped distribution; it is WITHHELD below
 * the subject-count floor (never thinned or partial); 'no_data' vs 'below_threshold'
 * are distinguished; and the state_version changes with the underlying set (ETag).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeNeighborhoodPulse, MIN_PULSE_SUBJECTS, type PulseSnapshotInput } from "../lib/intelPulse.js";

const snap = (subjectId: string, level: string, observedAt = "2026-09-04T20:00:00.000Z"): PulseSnapshotInput =>
  ({ subjectId, claimType: "crowd.level", value: { level }, observedAt });

describe("computeNeighborhoodPulse", () => {
  it("is 'no_data' with no crowd snapshots", () => {
    const p = computeNeighborhoodPulse([]);
    assert.equal(p.exposable, false);
    assert.equal(p.reason, "no_data");
    assert.equal(p.subjectCount, 0);
  });

  it("WITHHOLDS the aggregate below the subject-count floor (no small-cohort exposure)", () => {
    const below = Array.from({ length: MIN_PULSE_SUBJECTS - 1 }, (_, i) => snap(`p${i}`, "busy"));
    const p = computeNeighborhoodPulse(below);
    assert.equal(p.exposable, false);
    assert.equal(p.reason, "below_threshold");
    assert.deepEqual(p.levels, {}, "no distribution leaks below threshold");
    assert.equal(p.subjectCount, MIN_PULSE_SUBJECTS - 1);
  });

  it("exposes a distribution once the subject floor is cleared", () => {
    const at = MIN_PULSE_SUBJECTS;
    const snaps = [
      ...Array.from({ length: at - 1 }, (_, i) => snap(`p${i}`, "busy")),
      snap(`p${at}`, "packed"),
    ];
    const p = computeNeighborhoodPulse(snaps);
    assert.equal(p.exposable, true);
    assert.equal(p.reason, "ok");
    assert.equal(p.subjectCount, at);
    assert.equal(p.levels.busy, at - 1);
    assert.equal(p.levels.packed, 1);
  });

  it("dedupes multiple snapshots per subject to the FRESHEST", () => {
    const snaps = [
      snap("p1", "quiet", "2026-09-04T18:00:00.000Z"),
      snap("p1", "packed", "2026-09-04T20:00:00.000Z"), // freshest for p1
      snap("p2", "busy"), snap("p3", "busy"),
    ];
    const p = computeNeighborhoodPulse(snaps);
    assert.equal(p.subjectCount, 3, "p1 counted once");
    assert.equal(p.levels.packed, 1);
    assert.equal(p.levels.busy, 2);
    assert.equal(p.levels.quiet, undefined, "the stale p1 value is not counted");
  });

  it("ignores non-crowd.level and unparseable values", () => {
    const snaps = [
      snap("p1", "busy"), snap("p2", "busy"), snap("p3", "busy"),
      { subjectId: "p4", claimType: "queue.wait", value: { min: 10 }, observedAt: "2026-09-04T20:00:00.000Z" },
      { subjectId: "p5", claimType: "crowd.level", value: 42 as any, observedAt: "2026-09-04T20:00:00.000Z" },
    ];
    const p = computeNeighborhoodPulse(snaps);
    assert.equal(p.subjectCount, 3);
  });

  it("state_version tracks subject count and freshness (ETag driver)", () => {
    const a = computeNeighborhoodPulse([snap("p1", "busy"), snap("p2", "busy"), snap("p3", "busy")]);
    const b = computeNeighborhoodPulse([snap("p1", "busy"), snap("p2", "busy")]);
    assert.notEqual(a.stateVersion, b.stateVersion);
  });
});
