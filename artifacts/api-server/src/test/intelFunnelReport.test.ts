/**
 * intelFunnelReport (IG-09) — the read-only funnel + density-gate assembler that
 * wires the built-but-unwired density gate and pilot-metric shaper to the intel
 * tables. Proves: every stage is counted from real rows; unrecognised enum values
 * are surfaced as a reader defect, never folded into a real bucket; the
 * suppression reason is RE-DERIVED faithfully from the real privacy gate so its
 * check order is preserved (below the k=15 actor floor → below_actor_threshold;
 * past the floor with too few groups → below_group_threshold, split into
 * insufficient-groups vs group-identity-unavailable); and the density gate is
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

  it("re-derivation EXCLUDES moderation-invalidated observations (matches the aggregator)", () => {
    const allowed = observers(14); // actor-0..13, allowed
    const blocked = observers(5, { moderation_state: "blocked" }).map((o, i) => ({ ...o, actor_id: `blk-${i}` }));
    const rows: FunnelRows = { ...empty, observations: [...allowed, ...blocked], claims: [liveClaim] };
    const f = tallyIntelFunnel(rows, NOW);
    // Only the 14 allowed count → below the k=15 floor. If blocked were counted (19),
    // it would clear the floor and fail on groups instead.
    assert.equal(f.suppression.byReason["below_actor_threshold"], 1, "blocked excluded → 14 actors < 15");
    assert.equal(f.suppression.byReason["below_group_threshold"], 0);
    assert.equal(f.observations.pilotClaimable, 14);
  });

  it("below the k=15 floor → below_actor_threshold, not invalid_input", () => {
    const rows: FunnelRows = { ...empty, observations: observers(3), claims: [liveClaim] };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.suppression.evaluatedClaims, 1);
    assert.equal(f.suppression.publishable, 0);
    assert.equal(f.suppression.byReason["below_actor_threshold"], 1);
    assert.equal(f.suppression.byReason["invalid_input"], 0);
  });

  it("at the k=15 floor with NO group_key → below_group_threshold, classed 'group identity unavailable'", () => {
    const rows: FunnelRows = { ...empty, observations: observers(15), claims: [liveClaim] };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.suppression.evaluatedClaims, 1);
    assert.equal(f.suppression.publishable, 0, "never publishable without a group signal");
    assert.equal(f.suppression.byReason["below_group_threshold"], 1, "finite distinctGroups=0, not invalid_input");
    assert.equal(f.suppression.byReason["invalid_input"], 0);
    assert.equal(f.groupSignal.groupIdentityUnavailable, 1, "(B) no group_key at all");
    assert.equal(f.groupSignal.insufficientGroups, 0);
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

describe("intelFunnelReport — independent-group signal (owner refinement)", () => {
  const liveClaim = { subject_id: S, claim_type: CT, status: "active", observed_at: HOUR_AGO };
  const grouped = (n: number, keyOf: (i: number) => string | null, bucket?: string) =>
    Array.from({ length: n }, (_, i) => ({
      actor_id: `a${i}`, subject_id: S, claim_type: CT, moderation_state: "allowed",
      observed_at: HOUR_AGO, expires_at: FUTURE, group_key: keyOf(i), party_size_bucket: bucket ?? null,
    }));

  it("15 distinct solo groups → publishes (solo counts as an independent group)", () => {
    const rows: FunnelRows = { ...empty, observations: grouped(15, (i) => `solo-${i}`, "just_me"), claims: [liveClaim] };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.suppression.publishable, 1, "15 actors, 15 groups, share 1/15 ≤ 0.2, delay elapsed");
    assert.equal(f.groupSignal.groupEligibleObservations, 15);
    assert.equal(f.groupSignal.nullGroupObservations, 0);
    assert.equal(f.groupSignal.partyTally.byKey["just_me"], 15);
  });

  it("(A) 15 actors in 3 crews → below_group_threshold, classed 'insufficient independent groups'", () => {
    const rows: FunnelRows = { ...empty, observations: grouped(15, (i) => `crew-${Math.floor(i / 5)}`, "five_plus"), claims: [liveClaim] };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.suppression.byReason["below_group_threshold"], 1, "3 groups < 5");
    assert.equal(f.groupSignal.insufficientGroups, 1, "(A) has identity (3 groups), just not enough");
    assert.equal(f.groupSignal.groupIdentityUnavailable, 0);
  });

  it("counts group-eligible vs null-group observations and the party distribution", () => {
    const mix: FunnelRows = {
      ...empty,
      observations: [
        ...grouped(5, (i) => `solo-${i}`, "just_me"),          // eligible
        ...grouped(4, () => null, "five_plus").map((o, i) => ({ ...o, actor_id: `w${i}` })), // null-group, "with others"
      ],
      claims: [],
    };
    const f = tallyIntelFunnel(mix, NOW);
    assert.equal(f.groupSignal.groupEligibleObservations, 5);
    assert.equal(f.groupSignal.nullGroupObservations, 4);
    assert.equal(f.groupSignal.partyTally.byKey["just_me"], 5);
    assert.equal(f.groupSignal.partyTally.byKey["five_plus"], 4);
    assert.equal(f.groupSignal.partyTally.byKey["one_other"], 0, "known bucket shown at 0");
  });

  it("unattested captures land in the '(null)' party bucket (not silently dropped)", () => {
    const rows: FunnelRows = {
      ...empty,
      observations: [
        ...grouped(2, () => null),                 // party_size_bucket null
        ...grouped(1, () => `solo-x`, "just_me").map((o) => ({ ...o, actor_id: "z" })),
      ],
      claims: [],
    };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.groupSignal.partyTally.byKey["(null)"], 2, "unattested visible");
    assert.equal(f.groupSignal.partyTally.byKey["just_me"], 1);
  });

  it("union-based maxGroupShare in the funnel catches overlapping crews (matches the aggregator)", () => {
    const obs: any[] = [];
    for (let a = 0; a < 15; a++) for (let g = 0; g < 6; g++)
      obs.push({ actor_id: `a${a}`, subject_id: S, claim_type: CT, moderation_state: "allowed", observed_at: HOUR_AGO, expires_at: FUTURE, group_key: `g${g}`, party_size_bucket: null });
    const f = tallyIntelFunnel({ ...empty, observations: obs, claims: [liveClaim] }, NOW);
    assert.equal(f.suppression.byReason["single_group_dominates"], 1, "union share 1.0, not diluted 15/90");
    assert.equal(f.suppression.publishable, 0);
  });

  it("re-derives over the FULL fresh cohort (freshObservations), not the windowed set", () => {
    // The windowed observation set is EMPTY (contributors older than the report
    // window) but still fresh — the aggregator counts them, so the funnel must too.
    const rows: FunnelRows = { ...empty, observations: [], freshObservations: grouped(15, (i) => `solo-${i}`, "just_me"), claims: [liveClaim] };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.suppression.evaluatedClaims, 1);
    assert.equal(f.suppression.publishable, 1, "15 fresh solo groups → publishes, not a false below_actor_threshold");
  });
});

describe("intelFunnelReport — density gate is fail-closed, never certifiable here", () => {
  it("reports NOT met / NOT certifiable and lists the STILL-uninstrumented inputs", () => {
    const f = tallyIntelFunnel({ ...empty, observations: observers(50) }, NOW);
    const a = assessDensityGate(f, { qualifyingWeeklyObservations: 9999 });
    assert.equal(a.gate.met, false, "uninstrumented inputs force failure");
    assert.equal(a.certifiable, false, "never certifiable while inputs remain uninstrumented");
    // Now instrumented (no longer uninstrumented): outcomeConfirmations (measured),
    // minContributorsPerCluster (upper bound), minIndependentSourcesPerKeyVenueNight (measured).
    assert.ok(!a.uninstrumented.includes("outcomeConfirmations"), "outcomeConfirmations now measured");
    assert.ok(!a.uninstrumented.includes("minContributorsPerCluster"), "per-cluster now an upper bound");
    // Still uninstrumented (no reader yet): calibration accuracy + expiry correctness.
    assert.ok(a.uninstrumented.includes("crowdCalibrationAccuracy"));
    assert.ok(a.uninstrumented.includes("expiryCorrectness"));
    // Reliability-unmodelled inputs are upper bounds — never trusted to clear.
    assert.ok(a.upperBound.includes("activeReliableContributorsCitywide"));
    assert.ok(a.upperBound.includes("minContributorsPerCluster"));
    assert.equal(a.metrics.qualifyingWeeklyObservations, 9999, "measured input passed through");
    assert.equal(a.metrics.activeReliableContributorsCitywide, 50, "distinct actors as an upper bound");
  });
});

describe("intelFunnelReport — §26 density instrumentation (new readers)", () => {
  it("derives contributors per cluster (zone), weakest-link min over clusters", () => {
    const rows: FunnelRows = { ...empty, observations: [
      ...observers(3, { zone_id: "zA" }),
      ...observers(5, { zone_id: "zB" }).map((o, i) => ({ ...o, actor_id: `zb-${i}` })),
    ] };
    const f = tallyIntelFunnel(rows, NOW);
    assert.deepEqual(f.density.contributorsPerCluster, [3, 5]);
    const a = assessDensityGate(f, { qualifyingWeeklyObservations: 0 });
    assert.equal(a.metrics.minContributorsPerCluster, 3, "weakest cluster");
  });

  it("derives independent sources per key venue-night from distinct group_keys", () => {
    const rows: FunnelRows = { ...empty, observations: [
      { actor_id: "a1", subject_id: S, claim_type: CT, moderation_state: "allowed", observed_at: HOUR_AGO, expires_at: FUTURE, group_key: "g1" },
      { actor_id: "a2", subject_id: S, claim_type: CT, moderation_state: "allowed", observed_at: HOUR_AGO, expires_at: FUTURE, group_key: "g2" },
      { actor_id: "a3", subject_id: S, claim_type: CT, moderation_state: "allowed", observed_at: HOUR_AGO, expires_at: FUTURE, group_key: "g2" }, // same group
    ] };
    const f = tallyIntelFunnel(rows, NOW);
    assert.deepEqual(f.density.independentSourcesPerKeyVenueNight, [2], "2 distinct groups on the venue-night");
  });

  it("counts outcomes and after-proof pairs from outcome events", () => {
    const rows: FunnelRows = { ...empty, outcomes: [
      { subject_id: S, snapshot_id: "snap-1", outcome: "better", occurred_at: HOUR_AGO },
      { subject_id: S, snapshot_id: null, outcome: "same", occurred_at: HOUR_AGO }, // no snapshot ⇒ not a pair
    ] };
    const f = tallyIntelFunnel(rows, NOW);
    assert.equal(f.density.outcomeConfirmations, 2);
    assert.equal(f.density.afterProofPairs, 1, "only the outcome referencing a snapshot is an after-proof pair");
    const a = assessDensityGate(f, { qualifyingWeeklyObservations: 0 });
    assert.equal(a.metrics.outcomeConfirmations, 2, "flows into the gate metric");
  });
});
