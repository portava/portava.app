/**
 * Material conflict state (IG unit I2, spec §10 / AT-07) — the predicate and
 * its wiring into the projection aggregator.
 *
 * PROPERTIES UNDER TEST
 *   • semantic distance follows the spec's Table 6 value spaces: adjacent
 *     ladder values are a 'minor' disagreement, distant ones are material; a
 *     boolean access fact is material on any disagreement; a family with no
 *     ladder can only ever reach 'minor' (the module never invents a scale).
 *   • weight is INDEPENDENT weight: a crew of eight is one cluster (1.0), an
 *     unattested stranger is 0.5, and a two-cluster minority cannot pin
 *     "Reports differ" on a forty-cluster consensus.
 *   • reports outside the overlap window are sequence evidence, not conflict.
 *   • the aggregator persists the state on the ProjectionInput and folds the
 *     material-conflict penalty in — confidence can only go DOWN.
 *   • the serving cap only ever lowers a (confidence, band) pair.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  assessConflict,
  semanticDistance,
  normalizeConflictState,
  capForConflict,
  conflictBlock,
  overlapWindowSeconds,
  CONFLICT_MIN_WEIGHT,
  CONFLICT_MIN_MINORITY_SHARE,
  MIN_OVERLAP_WINDOW_SECONDS,
  type ConflictVote,
} from "../lib/intelConflict.js";
import { assembleClaimInput, type ClaimRow } from "../lib/intelProjectionAggregator.js";
import { invalidateFreshnessPolicyCache } from "../lib/freshnessPolicy.js";
import { CONFIDENCE_BAND_FLOOR } from "../lib/intelContracts.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const T = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const CROWD_TTL = 2700; // crowd.level — 45 min

/** n independent (group-keyed) actors asserting `value`, one cluster each. */
function independentVotes(prefix: string, n: number, value: unknown, minutesAgo = 5): ConflictVote[] {
  return Array.from({ length: n }, (_, i) => ({
    actorId: `${prefix}-a${i}`, clusterId: `${prefix}-g${i}`, independent: true, value, observedAt: T(minutesAgo),
  }));
}
/** n unattested actors (no group_key) — each their own 'unclear' cluster. */
function unclearVotes(prefix: string, n: number, value: unknown, minutesAgo = 5): ConflictVote[] {
  return Array.from({ length: n }, (_, i) => ({
    actorId: `${prefix}-u${i}`, clusterId: `actor:${prefix}-u${i}`, independent: false, value, observedAt: T(minutesAgo),
  }));
}
/** One crew of n actors sharing a cluster. */
function crewVotes(prefix: string, n: number, value: unknown, minutesAgo = 5): ConflictVote[] {
  return Array.from({ length: n }, (_, i) => ({
    actorId: `${prefix}-c${i}`, clusterId: `${prefix}-crew`, independent: true, value, observedAt: T(minutesAgo),
  }));
}

describe("intelConflict — semanticDistance (Table 6 value spaces)", () => {
  it("crowd.level is an ordinal ladder: adjacent = 1 (minor), two+ steps = material", () => {
    assert.deepEqual(semanticDistance("crowd.level", { level: "quiet" }, { level: "packed" }), { distance: 3, threshold: 2 });
    assert.deepEqual(semanticDistance("crowd.level", { level: "busy" }, { level: "packed" }), { distance: 1, threshold: 2 });
    assert.deepEqual(semanticDistance("crowd.level", { level: "busy" }, { level: "busy" }), { distance: 0, threshold: 2 });
    // Bare-string and object forms compare on the same ladder.
    assert.equal(semanticDistance("crowd.level", "quiet", { level: "busy" }).distance, 2);
    // Symmetric.
    assert.equal(semanticDistance("crowd.level", "packed", "quiet").distance, 3);
  });
  it("crowd.trajectory: building vs declining is material, peaking vs stable is agreement", () => {
    assert.equal(semanticDistance("crowd.trajectory", { trajectory: "building" }, { trajectory: "declining" }).distance, 2);
    assert.equal(semanticDistance("crowd.trajectory", { trajectory: "peaking" }, { trajectory: "stable" }).distance, 0);
    assert.equal(semanticDistance("crowd.trajectory", { trajectory: "building" }, { trajectory: "peaking" }).distance, 1);
  });
  it("queue.wait compares on the §6 entrance bands (none, <10, 10–20, 20–40, 40+)", () => {
    assert.equal(semanticDistance("queue.wait", { minMinutes: 0, maxMinutes: 0 }, { minMinutes: 40, maxMinutes: null }).distance, 4);
    assert.equal(semanticDistance("queue.wait", { minMinutes: 0, maxMinutes: 10 }, { minMinutes: 10, maxMinutes: 20 }).distance, 1);
    assert.equal(semanticDistance("queue.wait", { minMinutes: 0, maxMinutes: 10 }, { minMinutes: 20, maxMinutes: 40 }).distance, 2);
    assert.equal(semanticDistance("service.wait", { minMinutes: 10, maxMinutes: 20 }, { minMinutes: 10, maxMinutes: 20 }).distance, 0);
  });
  it("access.walk_in is a boolean fact: any disagreement is material", () => {
    assert.deepEqual(semanticDistance("access.walk_in", { accepted: true }, { accepted: false }), { distance: 1, threshold: 1 });
    assert.deepEqual(semanticDistance("access.walk_in", { accepted: true }, { accepted: true }), { distance: 0, threshold: 1 });
    // The spec's four-state ladder is also understood; 'unknown' contradicts nothing.
    assert.equal(semanticDistance("access.walk_in", "accepted", "denied").distance, 3);
    assert.equal(semanticDistance("access.walk_in", "accepted", "unknown").distance, 0);
  });
  it("crowd.direction: only arriving vs dispersing is a contradiction", () => {
    assert.equal(semanticDistance("crowd.direction", { direction: "arriving" }, { direction: "dispersing" }).distance, 2);
    assert.equal(semanticDistance("crowd.direction", { direction: "arriving" }, { direction: "holding" }).distance, 1);
    assert.equal(semanticDistance("crowd.direction", { direction: "holding" }, { direction: "holding" }).distance, 0);
  });
  it("event.status: cancelled contradicts every live phase; closure: open vs closed is material", () => {
    assert.equal(semanticDistance("event.status", { status: "under_way" }, { status: "cancelled" }).distance, 2);
    assert.equal(semanticDistance("event.status", { status: "starting_soon" }, { status: "under_way" }).distance, 1);
    assert.equal(semanticDistance("closure.state", { state: "open" }, { state: "temporarily_closed" }).distance, 2);
    assert.equal(semanticDistance("closure.state", { state: "temporarily_closed" }, { state: "closed_for_private_event" }).distance, 1);
  });
  it("price.cover: ≥50% apart is material, different currencies are incomparable", () => {
    assert.equal(semanticDistance("price.cover", { amount: 10, currency: "USD" }, { amount: 30, currency: "USD" }).distance, 2);
    assert.equal(semanticDistance("price.cover", { amount: 10, currency: "USD" }, { amount: 12, currency: "USD" }).distance, 1);
    assert.equal(semanticDistance("price.cover", { amount: 10, currency: "USD" }, { amount: 10, currency: "EUR" }).distance, 0);
  });
  it("a family with no ladder can only reach 'minor' — unequal is 1, below the threshold", () => {
    const d = semanticDistance("music.current", { genre: "techno" }, { genre: "jazz" });
    assert.equal(d.distance, 1);
    assert.ok(d.distance < d.threshold);
    assert.equal(semanticDistance("music.current", { genre: "jazz" }, { genre: "jazz" }).distance, 0);
    // Malformed values in a laddered family fall back the same way — never 0 when unequal.
    assert.equal(semanticDistance("crowd.level", { level: 42 }, { level: "busy" }).distance, 1);
  });
});

describe("intelConflict — assessConflict (the §10 predicate)", () => {
  const base = { claimType: "crowd.level", ttlSeconds: CROWD_TTL };

  it("agreement and a single side are 'none'", () => {
    assert.equal(assessConflict({ ...base, votes: [] }).state, "none");
    assert.equal(assessConflict({ ...base, votes: independentVotes("a", 6, { level: "busy" }) }).reason, "single_side");
    // Same value serialised with keys in a different order is still one side.
    const r = assessConflict({ ...base, votes: [
      ...independentVotes("a", 3, { level: "busy", zone: "main" }),
      ...independentVotes("b", 3, { zone: "main", level: "busy" }),
    ] });
    assert.equal(r.state, "none");
    assert.equal(r.sidesCount, 1);
  });

  it("two qualifying independent sides, distant values, overlapping windows ⇒ MATERIAL", () => {
    const r = assessConflict({ ...base, votes: [
      ...independentVotes("q", 3, { level: "quiet" }, 4),
      ...independentVotes("p", 3, { level: "packed" }, 6),
    ] });
    assert.equal(r.state, "material");
    assert.equal(r.reason, "material");
    assert.equal(r.sidesCount, 2);
    assert.equal(r.distance, 3);
    assert.ok(r.windowsOverlap && r.weightsQualify);
    // Sides carry counts only — no actor ids.
    assert.deepEqual(r.sides.map((s) => [s.actors, s.clusters, s.weight]), [[3, 3, 3], [3, 3, 3]]);
    assert.ok(!JSON.stringify(r.sides).includes("q-a0"));
  });

  it("adjacent values (busy vs packed) are 'minor', never material", () => {
    const r = assessConflict({ ...base, votes: [
      ...independentVotes("b", 4, { level: "busy" }),
      ...independentVotes("p", 4, { level: "packed" }),
    ] });
    assert.equal(r.state, "minor");
    assert.equal(r.reason, "adjacent_values");
  });

  it("reports outside the overlap window are sequence evidence, not contradiction", () => {
    // 'quiet' an hour ago, 'packed' now — a venue filling up. Crowd window is
    // ttl/2 = 22.5 min, so a 55-min gap is a sequence.
    const r = assessConflict({ ...base, votes: [
      ...independentVotes("q", 3, { level: "quiet" }, 60),
      ...independentVotes("p", 3, { level: "packed" }, 5),
    ] });
    assert.equal(r.state, "none");
    assert.equal(r.reason, "sequence_not_contradiction");
    assert.equal(r.windowsOverlap, false);
    // Inside the window it IS a contradiction.
    const near = assessConflict({ ...base, votes: [
      ...independentVotes("q", 3, { level: "quiet" }, 20),
      ...independentVotes("p", 3, { level: "packed" }, 5),
    ] });
    assert.equal(near.state, "material");
  });

  it("both sides must clear CONFLICT_MIN_WEIGHT in independent weight", () => {
    // One independent group disagreeing with three: minority weight 1 < 2.
    const r = assessConflict({ ...base, votes: [
      ...independentVotes("p", 3, { level: "packed" }),
      ...independentVotes("q", 1, { level: "quiet" }),
    ] });
    assert.equal(r.state, "minor");
    assert.equal(r.reason, "below_conflict_weight");
    assert.equal(CONFLICT_MIN_WEIGHT, 2);
  });

  it("a crew of eight is ONE cluster — it cannot carry a side on its own", () => {
    const r = assessConflict({ ...base, votes: [
      ...independentVotes("p", 4, { level: "packed" }),
      ...crewVotes("crew", 8, { level: "quiet" }),
    ] });
    assert.equal(r.state, "minor");
    assert.equal(r.reason, "below_conflict_weight");
    const crewSide = r.sides.find((s) => s.actors === 8)!;
    assert.equal(crewSide.clusters, 1);
    assert.equal(crewSide.weight, 1);
  });

  it("unattested strangers weigh 0.5: four make a side, three do not", () => {
    const four = assessConflict({ ...base, votes: [
      ...independentVotes("p", 4, { level: "packed" }),
      ...unclearVotes("q", 4, { level: "quiet" }),
    ] });
    assert.equal(four.state, "material");
    const three = assessConflict({ ...base, votes: [
      ...independentVotes("p", 4, { level: "packed" }),
      ...unclearVotes("q", 3, { level: "quiet" }),
    ] });
    assert.equal(three.state, "minor");
    assert.equal(three.reason, "below_conflict_weight");
  });

  it("a two-cluster minority cannot pin 'Reports differ' on a forty-cluster consensus", () => {
    const r = assessConflict({ ...base, votes: [
      ...independentVotes("p", 40, { level: "packed" }),
      ...independentVotes("q", 2, { level: "quiet" }),
    ] });
    assert.equal(r.state, "minor");
    assert.equal(r.reason, "below_conflict_weight");
    assert.ok(2 < CONFLICT_MIN_MINORITY_SHARE * 40);
    // At the share floor it qualifies again.
    const ok = assessConflict({ ...base, votes: [
      ...independentVotes("p", 10, { level: "packed" }),
      ...independentVotes("q", 2, { level: "quiet" }),
    ] });
    assert.equal(ok.state, "material");
  });

  it("uses only the TOP TWO sides and orders them deterministically", () => {
    const votes = [
      ...independentVotes("b", 5, { level: "busy" }),
      ...independentVotes("p", 3, { level: "packed" }),
      ...independentVotes("q", 2, { level: "quiet" }),
    ];
    const r = assessConflict({ ...base, votes });
    assert.equal(r.sidesCount, 3);
    assert.deepEqual(r.sides.map((s) => (s.value as any).level), ["busy", "packed"]);
    // busy vs packed is adjacent ⇒ minor, even though quiet vs busy would be material.
    assert.equal(r.state, "minor");
    // Reversed input order yields the identical assessment.
    const rev = assessConflict({ ...base, votes: [...votes].reverse() });
    assert.deepEqual(rev, r);
    // Equal-weight ties break on the value key, not on arrival order.
    const tie = assessConflict({ ...base, votes: [
      ...independentVotes("z", 3, { level: "quiet" }),
      ...independentVotes("a", 3, { level: "packed" }),
    ] });
    assert.deepEqual(tie.sides.map((s) => (s.value as any).level), ["packed", "quiet"]);
  });

  it("a walk-in boolean disagreement between two qualifying sides is material", () => {
    const r = assessConflict({ claimType: "access.walk_in", ttlSeconds: 1800, votes: [
      ...independentVotes("y", 2, { accepted: true }),
      ...independentVotes("n", 2, { accepted: false }),
    ] });
    assert.equal(r.state, "material");
  });
});

describe("intelConflict — helpers", () => {
  it("overlapWindowSeconds is half the TTL, floored at 15 minutes", () => {
    assert.equal(overlapWindowSeconds(2700), 1350);
    assert.equal(overlapWindowSeconds(1200), MIN_OVERLAP_WINDOW_SECONDS);
    assert.equal(overlapWindowSeconds(604800), 302400);
    assert.equal(overlapWindowSeconds(0), MIN_OVERLAP_WINDOW_SECONDS);
    assert.equal(overlapWindowSeconds(Number.NaN), MIN_OVERLAP_WINDOW_SECONDS);
  });
  it("normalizeConflictState: NULL/''/'none' ⇒ none; spec 'contextualized' ⇒ minor; anything else ⇒ material (fail-closed)", () => {
    assert.equal(normalizeConflictState(null), "none");
    assert.equal(normalizeConflictState(undefined), "none");
    assert.equal(normalizeConflictState(""), "none");
    assert.equal(normalizeConflictState("none"), "none");
    assert.equal(normalizeConflictState("minor"), "minor");
    assert.equal(normalizeConflictState("contextualized"), "minor");
    assert.equal(normalizeConflictState("MATERIAL"), "material");
    assert.equal(normalizeConflictState("something-new"), "material");
    assert.equal(normalizeConflictState(5), "material");
  });
  it("capForConflict only ever lowers, and only under 'material'", () => {
    const capped = capForConflict("material", 0.95, "strong");
    assert.equal(capped.band, "likely_current");
    assert.ok(capped.confidence !== null && capped.confidence < CONFIDENCE_BAND_FLOOR.live);
    assert.ok(capped.confidence !== null && capped.confidence >= CONFIDENCE_BAND_FLOOR.likely_current);
    assert.deepEqual(capForConflict("material", 0.8, "live").band, "likely_current");
    // Below the live band nothing changes.
    assert.deepEqual(capForConflict("material", 0.4, "provisional"), { confidence: 0.4, band: "provisional" });
    assert.deepEqual(capForConflict("material", null, "unverified"), { confidence: null, band: "unverified" });
    // Other states pass through untouched.
    assert.deepEqual(capForConflict("none", 0.95, "strong"), { confidence: 0.95, band: "strong" });
    assert.deepEqual(capForConflict("minor", 0.8, "live"), { confidence: 0.8, band: "live" });
  });
  it("conflictBlock is null for 'none' and counts-only otherwise", () => {
    assert.equal(conflictBlock("none", NOW.toISOString()), null);
    assert.deepEqual(conflictBlock("material", NOW.toISOString()), { state: "material", sidesCount: 2, lastUpdated: NOW.toISOString() });
    assert.deepEqual(conflictBlock("minor", NOW.toISOString()), { state: "minor", sidesCount: 2, lastUpdated: NOW.toISOString() });
  });
});

// ── Aggregator wiring ────────────────────────────────────────────────────────
/** Minimal fake of the tables assembleClaimInput reads. */
function makeDb(cfg: { observations: any[]; flags?: Record<string, boolean> }) {
  const consentRows = [...new Set(cfg.observations.map((o) => o.actor_id))]
    .map((id) => ({ user_id: id, enabled: true, withdrawn_at: null }));
  const tables: Record<string, any[]> = {
    intel_observations: cfg.observations.map((o) => ({ moderation_state: "allowed", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, ...o })),
    intel_contribution_consent: consentRows,
    intel_confirmations: [],
    intel_evidence: [],
    freshness_policies: [{ claim_type: "crowd.level", ttl_seconds: CROWD_TTL, note: null }],
  };
  return {
    from(table: string) {
      const eqs: [string, any][] = []; let inF: [string, any[]] | null = null;
      const rows = () => (tables[table] ?? []).filter((r) =>
        eqs.every(([c, v]) => r[c] === v) && (!inF || inF[1].includes(r[inF[0]])));
      const run = () => {
        if (table === "feature_flags") { const f = eqs.find(([c]) => c === "flag")?.[1]; return { data: { enabled: Boolean(cfg.flags?.[f]) }, error: null }; }
        return { data: rows(), error: null };
      };
      const b: any = {
        select() { return b; },
        eq(c: string, v: any) { eqs.push([c, v]); return b; },
        is(c: string, v: any) { eqs.push([c, v]); return b; },
        in(c: string, v: any[]) { inF = [c, v]; return b; },
        maybeSingle() { return Promise.resolve(run()); },
        then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
      };
      return b;
    },
  };
}

const obs = (actor: string, group: string | null, level: string, minutesAgo: number) => ({
  id: `o-${actor}`, actor_id: actor, subject_id: "place-1", claim_type: "crowd.level",
  value: { level }, observed_at: T(minutesAgo), group_key: group,
});
const claim: ClaimRow = { id: "c1", subject_id: "place-1", zone_id: null, claim_type: "crowd.level", value: { level: "busy" }, status: "active", observed_at: T(30) };

describe("intelProjectionAggregator — conflict state on the ProjectionInput", () => {
  beforeEach(() => invalidateFreshnessPolicyCache());

  it("two independent groups asserting distant values in one window ⇒ conflictState 'material' + the penalty", async () => {
    const db = makeDb({ observations: [
      obs("a1", "g1", "quiet", 4), obs("a2", "g2", "quiet", 5), obs("a3", "g3", "quiet", 6),
      obs("b1", "g4", "packed", 3), obs("b2", "g5", "packed", 7), obs("b3", "g6", "packed", 8),
    ] });
    const input = await assembleClaimInput(db, claim, NOW);
    assert.equal(input.conflictState, "material");
    assert.deepEqual(input.penalties, { materialConflict: 0.2 });
  });

  it("an agreeing cohort is 'none' and carries no penalty", async () => {
    const db = makeDb({ observations: [
      obs("a1", "g1", "busy", 4), obs("a2", "g2", "busy", 5), obs("a3", "g3", "busy", 6), obs("a4", "g4", "busy", 2),
    ] });
    const input = await assembleClaimInput(db, claim, NOW);
    assert.equal(input.conflictState, "none");
    assert.deepEqual(input.penalties, {});
  });

  it("uses each actor's MOST RECENT value — a contributor who re-reports switches sides", async () => {
    const db = makeDb({ observations: [
      obs("a1", "g1", "quiet", 4), obs("a2", "g2", "quiet", 5), obs("a3", "g3", "quiet", 6),
      obs("b1", "g4", "packed", 3), obs("b2", "g5", "packed", 7), obs("b3", "g6", "packed", 8),
      // The 'quiet' reporters look again and now say 'packed' (later observed_at).
      { ...obs("a1", "g1", "packed", 1), id: "o-a1-2" },
      { ...obs("a2", "g2", "packed", 1), id: "o-a2-2" },
      { ...obs("a3", "g3", "packed", 1), id: "o-a3-2" },
    ] });
    const input = await assembleClaimInput(db, claim, NOW);
    assert.equal(input.conflictState, "none");
    assert.deepEqual(input.value, { level: "packed" });
  });

  it("a stale minority (outside the overlap window) is sequence evidence — 'none'", async () => {
    const db = makeDb({ observations: [
      obs("a1", "g1", "quiet", 40), obs("a2", "g2", "quiet", 41),
      obs("b1", "g4", "packed", 3), obs("b2", "g5", "packed", 4),
    ] });
    const input = await assembleClaimInput(db, claim, NOW);
    assert.equal(input.conflictState, "none");
  });
});
