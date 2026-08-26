/**
 * intelFunnelReport (IG-09) — the read-only funnel + density-gate assembler that
 * wires the built-but-unwired density gate and pilot-metric shaper to the intel
 * tables. Proves: every stage is counted from real rows; unrecognised enum values
 * are surfaced as a reader defect, never folded into a real bucket; the
 * suppression reason is RE-DERIVED faithfully from the real privacy gate so its
 * check order is preserved (below the k=15 actor floor → below_actor_threshold;
 * at the floor but no group signal → invalid_input); and the density gate is
 * fail-closed — never certifiable while inputs are uninstrumented.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tallyIntelFunnel, assessDensityGate, type FunnelRows } from "../lib/intelFunnelReport.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const HOUR_AGO = new Date(NOW.getTime() - 3_600_000).toISOString();
const FUTURE = new Date(NOW.getTime() + 86_400_000).toISOString();
const PAST = new Date(NOW.getTime() - 86_400_000).toISOString();

const S = "11111111-1111-1111-1111-111111111111"; // a subject (place)
const CT = "crowd.level";

/** N distinct fresh observers of (S, CT). */
function observers(n: number, over: Record<string, unknown> = {}) {
  return Array.from({ length: n }, (_, i) => ({
    actor_id: `actor-${i}`,
    subject_id: S,
    claim_type: CT,
    moderation_state: "allowed",
    observed_at: HOUR_AGO,
    expires_at: FUTURE,
    ...over,
  }));
}

const empty: FunnelRows = { observations: [], claims: [], snapshots: [], confirmations: [] };

describe("intelFunnelReport — enum tallies surface, never fold, unrecognised values", () => {
  it("shows every known moderation key at 0 and buckets an unknown separately", () => {
    const rows: FunnelRows = {
      ...empty,
      observations: [
        { moderation_state: "allowed", actor_id: "a", subject_id: S, claim_type: CT, expires_at: FUTURE },
        { moderation_state: "pending", actor_id: "b", subject_id: S, claim_type: CT, expires_at: FUTURE },
        { moderation_state: "banished", actor_id: "c", subject_id: S, claim_type: CT, expires_at: FUTURE }, // not in enum
      ],
    };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.observations.tally.byKey["allowed"], 1);
    assert.equal(f.observations.tally.byKey["pending"], 1);
    assert.equal(f.observations.tally.byKey["blocked"], 0, "known key present even at 0");
    assert.equal(f.observations.tally.unknown, 1, "unrecognised value not folded into a real bucket");
    assert.deepEqual(f.observations.tally.unknownValues, ["banished"]);
    assert.equal(f.observations.eligibleForClaim, 1, "only 'allowed' backs a claim");
  });
});

describe("intelFunnelReport — snapshot servable-Live logic", () => {
  it("counts servable only when eligible AND band ≥ likely_current AND unexpired", () => {
    const rows: FunnelRows = {
      ...empty,
      snapshots: [
        { privacy_eligible: true, confidence_band: "live", expires_at: FUTURE },          // servable
        { privacy_eligible: true, confidence_band: "provisional", expires_at: FUTURE },    // band too low
        { privacy_eligible: true, confidence_band: "strong", expires_at: PAST },           // expired
        { privacy_eligible: false, confidence_band: "strong", expires_at: FUTURE },        // suppressed
        { privacy_eligible: true, confidence_band: null, expires_at: FUTURE },             // no band
      ],
    };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.snapshots.total, 5);
    assert.equal(f.snapshots.eligible, 4);
    assert.equal(f.snapshots.suppressed, 1);
    assert.equal(f.snapshots.expired, 1);
    assert.equal(f.snapshots.servableLive, 1, "only the eligible/live/unexpired one");
    assert.equal(f.snapshots.bandTally.byKey["(null)"], 1);
  });
});

describe("intelFunnelReport — contributor concentration", () => {
  it("counts distinct actors and the busiest actor's share", () => {
    const rows: FunnelRows = {
      ...empty,
      observations: [
        { actor_id: "a", subject_id: S, claim_type: CT, moderation_state: "allowed", expires_at: FUTURE },
        { actor_id: "a", subject_id: S, claim_type: CT, moderation_state: "allowed", expires_at: FUTURE },
        { actor_id: "a", subject_id: S, claim_type: CT, moderation_state: "allowed", expires_at: FUTURE },
        { actor_id: "b", subject_id: S, claim_type: CT, moderation_state: "allowed", expires_at: FUTURE },
      ],
    };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.contributor.distinctActors, 2);
    assert.equal(f.contributor.topActorObservations, 3);
    assert.equal(f.contributor.topActorShare, 0.75);
  });
});

describe("intelFunnelReport — suppression reason re-derivation (gate order preserved)", () => {
  const liveClaim = { subject_id: S, claim_type: CT, status: "active", observed_at: HOUR_AGO };

  it("below the k=15 floor → below_actor_threshold, not invalid_input", () => {
    const rows: FunnelRows = { ...empty, observations: observers(3), claims: [liveClaim] };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.suppression.evaluatedClaims, 1);
    assert.equal(f.suppression.publishable, 0);
    assert.equal(f.suppression.byReason["below_actor_threshold"], 1);
    assert.equal(f.suppression.byReason["invalid_input"], 0);
  });

  it("at the k=15 floor but no group signal → invalid_input (the pilot's blocking decision)", () => {
    const rows: FunnelRows = { ...empty, observations: observers(15), claims: [liveClaim] };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.suppression.evaluatedClaims, 1);
    assert.equal(f.suppression.publishable, 0, "never publishable without a group signal");
    assert.equal(f.suppression.byReason["invalid_input"], 1);
    assert.equal(f.suppression.byReason["below_actor_threshold"], 0);
  });

  it("expired observations do not count toward the actor floor (freshness)", () => {
    const rows: FunnelRows = { ...empty, observations: observers(20, { expires_at: PAST }), claims: [liveClaim] };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.suppression.byReason["below_actor_threshold"], 1, "20 stale observers → 0 fresh → below floor");
  });

  it("duplicate actors are counted once toward the floor", () => {
    const dup = observers(1).concat(observers(1)); // same actor-0 twice
    const rows: FunnelRows = { ...empty, observations: dup, claims: [liveClaim] };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.suppression.byReason["below_actor_threshold"], 1);
  });

  it("only active/conflicting claims are evaluated; candidate/superseded are skipped", () => {
    const rows: FunnelRows = {
      ...empty,
      observations: observers(3),
      claims: [
        liveClaim,
        { subject_id: S, claim_type: CT, status: "candidate", observed_at: HOUR_AGO },
        { subject_id: S, claim_type: CT, status: "superseded", observed_at: HOUR_AGO },
      ],
    };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.suppression.evaluatedClaims, 1, "only the active claim");
    assert.equal(f.claims.liveEligible, 1);
  });
});

describe("intelFunnelReport — density gate is fail-closed, never certifiable here", () => {
  it("reports NOT met / NOT certifiable and lists uninstrumented inputs even with many contributors", () => {
    const f = tallyIntelFunnel({ ...empty, observations: observers(50) }, NOW);
    const a = assessDensityGate(f, { qualifyingWeeklyObservations: 9999 });
    assert.equal(a.gate.met, false, "uninstrumented inputs force failure");
    assert.equal(a.certifiable, false, "never certifiable while inputs are uninstrumented");
    assert.ok(a.uninstrumented.includes("outcomeConfirmations"));
    assert.ok(a.uninstrumented.includes("minContributorsPerCluster"));
    assert.ok(a.upperBound.includes("activeReliableContributorsCitywide"));
    assert.equal(a.metrics.qualifyingWeeklyObservations, 9999, "measured input passed through");
    assert.equal(a.metrics.activeReliableContributorsCitywide, 50, "distinct actors as an upper bound");
  });
});
