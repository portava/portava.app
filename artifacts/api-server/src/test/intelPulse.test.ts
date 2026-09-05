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
    // The COUNT is part of what the floor refuses. routes/intelReadModels.ts
    // serves pulse.subjectCount on every response, withheld or not, so returning
    // the real below-floor size here published it.
    assert.equal(p.subjectCount, 0, "the below-floor cohort SIZE is withheld too");
    assert.equal(p.freshestObservedAt, null, "and so is the freshest observation time");
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
    // Pin the VALUE, not just the relationship: an exposable token is
    // `${subjectCount}:${freshestObservedAt}`, so two different exposable sets
    // cannot collide on an ETag.
    assert.equal(a.stateVersion, `3:${a.freshestObservedAt}`);
  });
});

// ── The below-floor response discloses NOTHING about the rows it refused ──────
//
// The leak this fixes: `levels` was suppressed but `subjectCount` and
// `state_version` (which was `${subjectCount}:${freshestObservedAt}`) were served
// anyway by routes/intelReadModels.ts. A caller could read a neighborhood twice —
// or read two adjacent neighborhoods — and difference the count and the
// millisecond-precision observation time back into a single venue's live state.
// Every below-floor cohort must therefore produce the SAME bytes.
describe("computeNeighborhoodPulse — below the floor, every cohort looks identical", () => {
  const freshIso = "2026-09-04T23:59:59.123Z";
  const oldIso = "2026-09-04T18:00:00.000Z";

  // Sizes derived from the gate's own constant, never hard-coded: 1 .. floor-1.
  const belowFloorSizes = Array.from({ length: MIN_PULSE_SUBJECTS - 1 }, (_, i) => i + 1);

  it("is sanity-checked to actually exercise a below-floor range", () => {
    assert.ok(belowFloorSizes.length >= 1, "MIN_PULSE_SUBJECTS must leave a below-floor range to test");
    for (const n of belowFloorSizes) assert.ok(n < MIN_PULSE_SUBJECTS);
  });

  it("returns byte-identical output for every below-floor cohort size and freshness", () => {
    const shapes = belowFloorSizes.flatMap((n) => [
      Array.from({ length: n }, (_, i) => snap(`p${i}`, "packed", freshIso)),
      Array.from({ length: n }, (_, i) => snap(`q${i}`, "dead", oldIso)),
    ]);
    const results = shapes.map((s) => computeNeighborhoodPulse(s));
    for (const r of results) assert.equal(r.exposable, false);
    const first = JSON.stringify(results[0]);
    for (const r of results) {
      assert.equal(JSON.stringify(r), first, "two below-floor cohorts must be indistinguishable on the wire");
    }
  });

  it("the withheld state_version carries neither the cohort size nor an observation time", () => {
    const one = computeNeighborhoodPulse([snap("only", "packed", freshIso)]);
    assert.equal(one.reason, "below_threshold");
    assert.ok(!one.stateVersion.includes(freshIso), "no observation timestamp in the ETag driver");
    assert.ok(!/\d/.test(one.stateVersion.replace(/below_threshold/g, "")), "no cohort count in the ETag driver");
    assert.equal(one.freshestObservedAt, null);
    assert.equal(one.subjectCount, 0);
  });

  it("no_data and below_threshold do not share an ETag (a 304 must not serve the wrong body)", () => {
    const empty = computeNeighborhoodPulse([]);
    const one = computeNeighborhoodPulse([snap("only", "packed", freshIso)]);
    assert.notEqual(empty.stateVersion, one.stateVersion);
    // ...and the empty token keeps its historic spelling, which is also the
    // literal routes/intelReadModels.ts emits when Live is globally off, so
    // "nothing to show" reads the same whatever the cause.
    assert.equal(empty.stateVersion, "0:-");
  });

  it("crossing the floor is the ONLY thing that changes the token", () => {
    const below = computeNeighborhoodPulse(
      Array.from({ length: MIN_PULSE_SUBJECTS - 1 }, (_, i) => snap(`p${i}`, "busy", freshIso)),
    );
    const at = computeNeighborhoodPulse(
      Array.from({ length: MIN_PULSE_SUBJECTS }, (_, i) => snap(`p${i}`, "busy", freshIso)),
    );
    assert.equal(below.exposable, false);
    assert.equal(at.exposable, true);
    assert.notEqual(below.stateVersion, at.stateVersion);
    assert.equal(at.subjectCount, MIN_PULSE_SUBJECTS, "the count is published only once it has cleared its own floor");
  });
});
