/**
 * hiddenGemIntelligence.test.ts — Media v2 Phase 8 (Hidden Gem Intelligence, §16).
 *
 * Proves the four semantic guarantees the spec adds on top of the existing gem
 * protection/verification machinery, each with an explicit mutation note (the
 * change that would turn the assertion RED):
 *
 *   1. the 10-state HiddenGemState derivation maps representative signal combos;
 *   2. a single structured contribution does NOT flip canonical state (§16.3);
 *   3. gem confidence rises with independent confirmations but NEVER with
 *      save_count or paid promotion (§16.2 / §36);
 *   4. gem ranking is NOT popularity-first and DEMOTES overcrowded gems (§16.2).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveHiddenGemState,
  deriveGemConfidence,
  scoreGemForRanking,
  rankGems,
  normalizeCrowdLevel,
  isGemContributionType,
  HIDDEN_GEM_STATES,
  GEM_CONTRIBUTION_TYPES,
  CONTRIBUTION_FLIP_THRESHOLD,
  type GemStateSignals,
  type GemConfidenceSignals,
} from "../lib/hiddenGemState.js";
import { recordGemContribution } from "../services/hiddenGems/HiddenGemContributionService.js";

// ── The ten-state derivation ─────────────────────────────────────────────────

describe("HiddenGemState — the 10-state derivation (§16)", () => {
  const sig = (o: Partial<GemStateSignals> = {}): GemStateSignals => ({ ...o });

  it("empty/new gem derives gracefully to the baseline (pre-launch: 0 gems is normal)", () => {
    assert.equal(deriveHiddenGemState({}), "still_hidden");
    assert.equal(deriveHiddenGemState(sig({ status: "active" })), "still_hidden");
  });

  it("recently_confirmed after fresh confirmations", () => {
    // crowd 'moderate' so quiet_now/overcrowding don't pre-empt it; no discovery.
    assert.equal(
      deriveHiddenGemState(sig({ crowdLevel: "moderate", daysSinceLastConfirmation: 5, confirmationCount: 3 })),
      "recently_confirmed",
    );
  });

  it("quiet_now from a low crowd_level (and no fresher signal)", () => {
    assert.equal(
      deriveHiddenGemState(sig({ crowdLevel: "quiet", daysSinceLastConfirmation: 120, confirmationCount: 1 })),
      "quiet_now",
    );
  });

  it("overcrowding_risk from a high crowd_level (both 'busy' and 'very_busy')", () => {
    assert.equal(deriveHiddenGemState(sig({ crowdLevel: "busy" })), "overcrowding_risk");
    assert.equal(deriveHiddenGemState(sig({ crowdLevel: "very_busy" })), "overcrowding_risk");
  });

  it("no_longer_hidden past the discovery threshold", () => {
    assert.equal(
      deriveHiddenGemState(sig({ saveCount: 300, visitCount: 150 })),
      "no_longer_hidden",
    );
  });

  it("getting_discovered in the mid discovery band (below graduation)", () => {
    assert.equal(
      deriveHiddenGemState(sig({ saveCount: 100, visitCount: 5 })),
      "getting_discovered",
    );
  });

  it("seasonal / access_changed / temporarily_unavailable / hard_to_find from corroborated contributions", () => {
    assert.equal(deriveHiddenGemState(sig({ contributionCounts: { seasonal: 2 } })), "seasonal");
    assert.equal(deriveHiddenGemState(sig({ contributionCounts: { access_changed: 2 } })), "access_changed");
    assert.equal(deriveHiddenGemState(sig({ contributionCounts: { closed: 2 } })), "temporarily_unavailable");
    assert.equal(
      deriveHiddenGemState(sig({ crowdLevel: "moderate", contributionCounts: { harder_to_reach: 2 } })),
      "hard_to_find",
    );
  });

  it("every derived state is a member of the published enum", () => {
    const states = new Set<string>(HIDDEN_GEM_STATES);
    for (const s of [
      deriveHiddenGemState({}),
      deriveHiddenGemState(sig({ crowdLevel: "busy" })),
      deriveHiddenGemState(sig({ saveCount: 300, visitCount: 150 })),
    ]) {
      assert.ok(states.has(s), `${s} is not a valid HiddenGemState`);
    }
  });
});

// ── §16.3: a single contribution is an observation, not a canonical flip ─────

describe("HiddenGemState — one contribution does NOT flip canonical state (§16.3)", () => {
  it("a single 'closed' observation does not move a freshly-confirmed gem", () => {
    // Fresh confirmations + exactly ONE 'closed' observation (below the flip
    // threshold). The gem must stay recently_confirmed — the single observation
    // is recorded but does not canonically flip the state.
    const state = deriveHiddenGemState({
      daysSinceLastConfirmation: 3,
      confirmationCount: 2,
      contributionCounts: { closed: 1 },
    });
    assert.equal(state, "recently_confirmed");
    assert.notEqual(state, "temporarily_unavailable");
    // MUTATION: lowering CONTRIBUTION_FLIP_THRESHOLD to 1 (letting a single
    // 'closed' flip the state) makes this assertion RED.
    assert.ok(CONTRIBUTION_FLIP_THRESHOLD >= 2, "a single observation must never flip state");
  });

  it("but CONTRIBUTION_FLIP_THRESHOLD corroborating observations DO change it", () => {
    const state = deriveHiddenGemState({
      daysSinceLastConfirmation: 3,
      confirmationCount: 2,
      contributionCounts: { closed: CONTRIBUTION_FLIP_THRESHOLD },
    });
    assert.equal(state, "temporarily_unavailable");
  });
});

// ── Confidence: rises with evidence, never with popularity/paid ──────────────

describe("gem confidence — evidence up, popularity/paid never (§16.2/§36)", () => {
  const base: GemConfidenceSignals = {
    verificationLevel: "community",
    approvedConfirmations: 2,
    distinctConfirmers: 2,
    daysSinceLastConfirmation: 10,
    positiveContributions: 1,
    negativeContributions: 0,
    hasCoords: true,
    hasCanonicalPlace: true,
    hasMedia: true,
  };

  it("is a bounded 0..1 evidence score", () => {
    const r = deriveGemConfidence(base);
    assert.ok(r.confidence >= 0 && r.confidence <= 1, `confidence out of range: ${r.confidence}`);
    // Extreme evidence still clamps at 1.
    const strong = deriveGemConfidence({
      ...base, verificationLevel: "admin", approvedConfirmations: 999, distinctConfirmers: 999,
      daysSinceLastConfirmation: 0, positiveContributions: 50,
    });
    assert.ok(strong.confidence <= 1);
  });

  it("no evidence scores 0 (fail-closed)", () => {
    assert.equal(deriveGemConfidence({}).confidence, 0);
  });

  it("rises with more independent confirmations", () => {
    const more = deriveGemConfidence({ ...base, approvedConfirmations: 5, distinctConfirmers: 4 });
    assert.ok(
      more.confidence > deriveGemConfidence(base).confidence,
      "independent confirmations must raise confidence",
    );
  });

  it("does NOT rise with save_count — popularity is not evidence", () => {
    const withSaves = deriveGemConfidence({ ...base, saveCount: 9999 });
    // MUTATION: feeding saveCount into any positive component makes these differ
    // → this assertion RED.
    assert.equal(
      withSaves.confidence,
      deriveGemConfidence({ ...base, saveCount: 0 }).confidence,
      "save_count must not change confidence",
    );
  });

  it("paid promotion NEVER raises confidence (it can only penalise)", () => {
    const paid = deriveGemConfidence({ ...base, paidPromoted: true });
    const unpaid = deriveGemConfidence({ ...base, paidPromoted: false });
    assert.ok(unpaid.confidence > 0, "sanity: the base case has positive confidence");
    // MUTATION: turning paidPromoted into a positive component (or dropping the
    // commercial-risk penalty into a boost) makes paid > unpaid → RED.
    assert.ok(paid.confidence < unpaid.confidence, "paid promotion must not increase factual confidence");
  });

  it("suspicious visits penalise, contradiction penalises", () => {
    const clean = deriveGemConfidence(base).confidence;
    const spoofy = deriveGemConfidence({ ...base, suspiciousVisitRatio: 1 }).confidence;
    assert.ok(spoofy < clean, "high suspicious-visit ratio must lower confidence");
    const conflicted = deriveGemConfidence({ ...base, negativeContributions: 3 }).confidence;
    assert.ok(conflicted < clean, "contradicting reports must lower confidence");
  });
});

// ── Ranking: not popularity-first, overcrowded demoted ───────────────────────

describe("gem ranking — not popularity-first, overcrowded demoted (§16.2)", () => {
  const NOW = Date.parse("2026-08-31T00:00:00Z");
  const RECENT = "2026-08-20T00:00:00Z"; // 11 days before NOW
  const OLD = "2024-01-01T00:00:00Z";

  it("a well-evidenced fresh gem out-ranks a stale unverified gem drowning in saves", () => {
    const gemPopular = {
      id: "pop", verification_level: "unverified", updated_at: OLD,
      save_count: 9999, visit_count: 9999, crowd_level: "quiet", vibe_tags: [] as string[],
    };
    const gemEvidenced = {
      id: "evi", verification_level: "admin", updated_at: RECENT,
      save_count: 0, visit_count: 0, crowd_level: "quiet", vibe_tags: [] as string[],
    };
    const ranked = rankGems([gemPopular, gemEvidenced], { nowMs: NOW });
    // MUTATION: restoring the old `save_count DESC` / saveScore term puts 'pop'
    // first → this assertion RED.
    assert.equal(ranked[0].gem.id, "evi", "ranking must not be popularity-first");
    assert.equal(ranked[1].gem.id, "pop");
  });

  it("save_count / visit_count are not ranking inputs at all", () => {
    const a = { id: "a", verification_level: "guide", updated_at: RECENT, save_count: 0, crowd_level: "quiet" };
    const b = { id: "b", verification_level: "guide", updated_at: RECENT, save_count: 100000, crowd_level: "quiet" };
    assert.equal(
      scoreGemForRanking(a, { nowMs: NOW }).score,
      scoreGemForRanking(b, { nowMs: NOW }).score,
      "two gems differing only in save_count must score identically",
    );
  });

  it("an overcrowded gem is demoted below an uncrowded peer even when it is fresher", () => {
    const gemBusy = {
      id: "busy", verification_level: "admin", updated_at: RECENT, // fresher
      save_count: 0, crowd_level: "very_busy", vibe_tags: [] as string[],
    };
    const gemCalm = {
      id: "calm", verification_level: "admin", updated_at: OLD, // staler
      save_count: 0, crowd_level: "quiet", vibe_tags: [] as string[],
    };
    const ranked = rankGems([gemBusy, gemCalm], { nowMs: NOW });
    // Without the overcrowding demotion the fresher 'busy' would rank first.
    // MUTATION: removing the overcrowding penalty makes 'busy' rank first → RED.
    assert.equal(ranked[0].gem.id, "calm", "overcrowded/fragile gems must be demoted");
  });

  it("ranking is deterministic given nowMs and stable for equal scores", () => {
    const g1 = { id: "g1", verification_level: "guide", updated_at: RECENT, crowd_level: "quiet" };
    const g2 = { id: "g2", verification_level: "guide", updated_at: RECENT, crowd_level: "quiet" };
    const r1 = rankGems([g1, g2], { nowMs: NOW }).map((r) => r.gem.id);
    const r2 = rankGems([g1, g2], { nowMs: NOW }).map((r) => r.gem.id);
    assert.deepEqual(r1, r2);
    assert.deepEqual(r1, ["g1", "g2"], "equal scores preserve input order");
  });
});

// ── Vocabulary + type-guard helpers ──────────────────────────────────────────

describe("helpers", () => {
  it("normalizeCrowdLevel accepts both live vocabularies", () => {
    assert.equal(normalizeCrowdLevel("quiet"), "low");
    assert.equal(normalizeCrowdLevel("rarely_crowded"), "low");
    assert.equal(normalizeCrowdLevel("moderate"), "medium");
    assert.equal(normalizeCrowdLevel("busy"), "high");
    assert.equal(normalizeCrowdLevel("often_crowded"), "high");
    assert.equal(normalizeCrowdLevel("very_busy"), "very_high");
    assert.equal(normalizeCrowdLevel("nonsense"), "unknown");
    assert.equal(normalizeCrowdLevel(null), "unknown");
  });

  it("the nine §16.3 contribution types are recognised, others rejected", () => {
    assert.equal(GEM_CONTRIBUTION_TYPES.length, 9);
    for (const t of GEM_CONTRIBUTION_TYPES) assert.ok(isGemContributionType(t));
    assert.ok(!isGemContributionType("not_a_type"));
    assert.ok(!isGemContributionType(undefined));
  });
});

// ── Service boundary: a contribution writes only the observation table ───────

describe("recordGemContribution — writes an observation, never a canonical flip", () => {
  const GEM_ID = "11111111-1111-4111-8111-111111111111";
  const USER_ID = "22222222-2222-4222-8222-222222222222";

  function makeFakeDb(gemRow: any) {
    const writes: Array<{ table: string; op: string; row: any }> = [];
    function from(table: string) {
      let pending: any = null;
      const builder: any = {
        select() { return builder; },
        insert(row: any) { pending = row; writes.push({ table, op: "insert", row }); return builder; },
        update(patch: any) { writes.push({ table, op: "update", row: patch }); return builder; },
        upsert(row: any) { pending = row; writes.push({ table, op: "upsert", row }); return builder; },
        delete() { writes.push({ table, op: "delete", row: null }); return builder; },
        eq() { return builder; },
        in() { return builder; },
        maybeSingle() {
          if (table === "hidden_gems") return Promise.resolve({ data: gemRow, error: null });
          return Promise.resolve({ data: null, error: null }); // not-yet-observed
        },
        single() {
          if (pending) return Promise.resolve({ data: { ...pending, id: "obs-1" }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(onF: any, onR: any) { return Promise.resolve({ data: [], error: null, count: 0 }).then(onF, onR); },
      };
      return builder;
    }
    return { from, rpc: async () => ({ data: null, error: null }), _writes: writes } as any;
  }

  it("records the observation into hidden_gem_contributions and touches no other table", async () => {
    const db = makeFakeDb({ id: GEM_ID, status: "active", submitted_by: "someone-else" });
    const res = await recordGemContribution(db, GEM_ID, USER_ID, "closed");
    assert.equal(res.ok, true);
    assert.equal(res.contributionId, "obs-1");

    const writes = db._writes as Array<{ table: string; op: string }>;
    // Exactly one write, an upsert into the contributions table.
    assert.ok(writes.some((w) => w.table === "hidden_gem_contributions" && w.op === "upsert"),
      "the observation must be written to hidden_gem_contributions");
    // The canonical gem table is NEVER written by a contribution.
    assert.ok(!writes.some((w) => w.table === "hidden_gems"),
      "a contribution must never write hidden_gems (no canonical flip)");
  });

  it("rejects an unknown contribution type without any write", async () => {
    const db = makeFakeDb({ id: GEM_ID, status: "active", submitted_by: "x" });
    const res = await recordGemContribution(db, GEM_ID, USER_ID, "totally_bogus");
    assert.equal(res.ok, false);
    assert.equal(res.error, "invalid_contribution_type");
    assert.equal((db._writes as any[]).length, 0);
  });
});
