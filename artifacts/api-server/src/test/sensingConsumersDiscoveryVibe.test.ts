/**
 * sensingConsumers — the two §5.1/§5.2 consumer rows this lane closes in
 * `lib/discoveryCandidate` and `lib/vibeInference`.
 *
 *   S49  `DiscoveryCandidate` carries the FOURTH §5.1 field, `coverage`, and is
 *        routed through `lib/protectedLocations` before it may publish it.
 *   S51  `VibeFeatureInput` carries §5.2's seventh signal, `density`, bucketed
 *        in coverage's own vocabulary, and the inference USES it.
 *
 * Every assertion below was watched fail against the pre-change tree (the
 * source edits stashed, this file kept) before it was allowed to pass.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coverageForCandidate,
  projectDiscoveryCandidate,
  type CandidateServeContext,
} from "../lib/discoveryCandidate.js";
import type { DiscoveryLiveRank } from "../lib/discoveryLiveRank.js";
import type { ProtectedZone } from "../lib/protectedLocations.js";
import { inferVibe, type VibeFeatureInput } from "../lib/vibeInference.js";
import type { CoverageBucket } from "../lib/truthClass.js";

const NOW = Date.UTC(2026, 8, 20, 21, 0, 0);

// ── S49 fixtures ─────────────────────────────────────────────────────────────

/** A live grade carrying one coverage bucket. Only `truth.coverage` is read. */
function grade(id: string, coverage: CoverageBucket): DiscoveryLiveRank {
  return {
    id,
    mode: "explore",
    evidence: "reading",
    axes: {
      compatibility: null, forecast: null, travel: null, friction: null,
      freshness: null, interception: null, durability: null,
    },
    opportunityValue: 0.5,
    influence: 0,
    safety: { unsafe: false, demoted: false },
    truth: {
      truthClass: "observed",
      confidence: "likely_current",
      freshness: "live",
      coverage,
      provenance: ["community_verified"],
    },
    interception: {
      reachable: null, etaMinutes: null, arrivalAt: null, horizonAt: null, marginMinutes: null,
    },
    whyNow: ["busy"],
    claimRefs: ["snap-1"],
  };
}

/**
 * A COARSEN-class zone (medical_facility). Chosen deliberately: it is the
 * WEAKEST protected action, so a row inside it would be served by the Map with
 * `coverage` deleted rather than suppressed outright. If the conservative arm
 * holds for the weakest action it holds for every stronger one.
 */
const HOSPITAL_ZONE: ProtectedZone = {
  id: "zone-hospital",
  category: "medical_facility",
  shape: "circle",
  center: { lat: 10, lng: 20 },
  radiusMeters: 500,
};

function serveCtx(over: Partial<CandidateServeContext> = {}): CandidateServeContext {
  return {
    cacheLevel: "L1",
    cachedAt: NOW - 1000,
    scoredById: null,
    rankedBy: "none",
    liveRankById: new Map([["p1", grade("p1", "several")]]),
    nowMs: NOW,
    ...over,
  };
}

describe("S49 — DiscoveryCandidate carries coverage, through protectedLocations", () => {
  it("publishes the bucket when a §24 pass ran and cleared the row", () => {
    const ctx = serveCtx({
      protectedZones: [HOSPITAL_ZONE],
      // Far from the zone — a different hemisphere, so no geometry subtlety.
      positionById: new Map([["p1", { lat: -40, lng: -70 }]]),
    });
    const decision = coverageForCandidate("p1", ctx);
    assert.equal(decision.reason, "served");
    assert.equal(decision.coverage, "several");

    // And the projection carries it — the field exists on the wire shape.
    const candidate = projectDiscoveryCandidate({ id: "p1" }, ctx);
    assert.equal(candidate.coverage, "several");
  });

  it("WITHHOLDS the bucket inside a protected zone — the §24 hole, closed", () => {
    const ctx = serveCtx({
      protectedZones: [HOSPITAL_ZONE],
      positionById: new Map([["p1", { lat: 10, lng: 20 }]]),
    });
    const decision = coverageForCandidate("p1", ctx);
    assert.equal(decision.reason, "protected_zone");
    assert.equal(decision.coverage, "unknown");
    assert.equal(projectDiscoveryCandidate({ id: "p1" }, ctx).coverage, "unknown");
  });

  it("fails CLOSED when the serve point ran no pass at all", () => {
    // The census's exact objection: copying the Map's bucket across WITHOUT the
    // coarsening pass would publish a cohort signal the Map withholds. A serve
    // point that passes no zones gets nothing, not the bucket.
    const noZones = coverageForCandidate("p1", serveCtx());
    assert.equal(noZones.reason, "pass_did_not_run");
    assert.equal(noZones.coverage, "unknown");

    // Zones passed but no position for this row: equally unproven, equally closed.
    const noPosition = coverageForCandidate("p1", serveCtx({ protectedZones: [HOSPITAL_ZONE] }));
    assert.equal(noPosition.reason, "pass_did_not_run");
    assert.equal(noPosition.coverage, "unknown");
  });

  it("reports no_reading rather than protected when there is no grade", () => {
    // An absence must never be dressed up as a withholding: that would make
    // "this place is protected" inferable from a row that was simply ungraded.
    const ctx = serveCtx({
      liveRankById: new Map(),
      protectedZones: [HOSPITAL_ZONE],
      positionById: new Map([["p1", { lat: 10, lng: 20 }]]),
    });
    assert.deepEqual(coverageForCandidate("p1", ctx), { coverage: "unknown", reason: "no_reading" });
  });

  it("the published candidate cannot distinguish withheld from unread", () => {
    // Both cases serialise identically — no reason code on the wire.
    const withheld = projectDiscoveryCandidate({ id: "p1" }, serveCtx({
      protectedZones: [HOSPITAL_ZONE],
      positionById: new Map([["p1", { lat: 10, lng: 20 }]]),
    }));
    const unread = projectDiscoveryCandidate({ id: "p1" }, serveCtx({ liveRankById: new Map() }));
    assert.equal(withheld.coverage, unread.coverage);
    const json = JSON.stringify(withheld);
    for (const leak of ["protected_zone", "pass_did_not_run", "zone-hospital", "medical"]) {
      assert.ok(!json.includes(leak), `candidate leaked ${leak}`);
    }
  });

  it("publishes no coordinate, even though the pass reads one", () => {
    const json = JSON.stringify(projectDiscoveryCandidate({ id: "p1" }, serveCtx({
      protectedZones: [HOSPITAL_ZONE],
      positionById: new Map([["p1", { lat: -40, lng: -70 }]]),
    })));
    for (const leak of ["-40", "-70", "lat", "lng", "coordinates"]) {
      assert.ok(!json.includes(leak), `candidate leaked ${leak}`);
    }
  });
});

// ── S51 ──────────────────────────────────────────────────────────────────────

function features(over: Partial<VibeFeatureInput> = {}): VibeFeatureInput {
  return {
    motionEnergy: 0.5,
    periodicity: 0.8,
    boundedMovement: true,
    dwellBucket: 2,
    arrivalVelocity: 0.5,
    departureVelocity: 0.5,
    coverage: "many",
    venueContext: null,
    observedAt: NOW - 60_000,
    ...over,
  };
}

function ok(over: Partial<VibeFeatureInput> = {}) {
  const r = inferVibe(features(over), NOW);
  assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.state;
}

describe("S51 — density joins VibeFeatureInput and moves the inference", () => {
  it("density is a real input: a sparser place is less social than a packed one", () => {
    const packed = ok({ density: "many" }).sociality;
    const sparse = ok({ density: "few" }).sociality;
    assert.ok(packed !== null && sparse !== null);
    assert.ok(sparse! < packed!, `expected few (${sparse}) < many (${packed}) — density is not read`);
  });

  it("coverage CAPS density: one device is still not a crowd", () => {
    // `many` people reported by a `few`-contributor cohort may not be served as
    // a bigger crowd than a `few`-contributor cohort can carry.
    const thinEvidence = ok({ coverage: "few", density: "many" }).sociality;
    const thinBoth = ok({ coverage: "few", density: "few" }).sociality;
    assert.equal(thinEvidence, thinBoth);
  });

  it("no density ≠ empty: absent and `unknown` leave sociality where coverage put it", () => {
    const baseline = ok().sociality;
    assert.equal(ok({ density: null }).sociality, baseline);
    assert.equal(ok({ density: "unknown" }).sociality, baseline);
    // And it is not zeroed — the failure this invariant exists to prevent.
    assert.ok(baseline !== null && baseline! > 0);
  });

  it("density may not raise dance_likelihood — occupancy is not behaviour", () => {
    const empty = ok({ density: "few" }).danceLikelihood;
    const packed = ok({ density: "many" }).danceLikelihood;
    assert.equal(empty, packed);
  });

  it("an off-vocabulary density is refused, not coerced to unknown", () => {
    assert.deepEqual(
      inferVibe(features({ density: "heaving" as never }), NOW),
      { ok: false, reason: "invalid_input", field: "density" },
    );
  });

  it("no coverage still beats any density: nothing is inferred from nothing", () => {
    const s = ok({ coverage: "unknown", density: "many" });
    assert.equal(s.sociality, null);
    assert.equal(s.truth.truthClass, "unknown");
  });
});
