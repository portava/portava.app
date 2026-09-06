/**
 * creatorActivityScore.test.ts
 *
 * Unit tests for CreatorActivityScoreService.
 * All tests are DB-free — they drive the pure scoring functions directly with
 * synthetic signal inputs.
 *
 * Acceptance criteria covered:
 *   1. Diminishing returns: posting 100× does not score 100× posting once.
 *   2. Time decay: recent contributions outweigh older ones.
 *   3. Spam-penalty cap: spam penalty is capped at −25.
 *   4. Self-engagement exclusion: self-actions are excluded from positive signals.
 *   5. Blocked-account exclusion: impressions/participation from blocklisted
 *      actors do not inflate scores (exclusion is at aggregation; here we verify
 *      the formula doesn't inflate with zeroed signals).
 *   6. Safety-multiplier collapse: multiplier 0.0 forces final score to 0.
 *   7. New-user with zero history scores in the middle range (not zero).
 *   8. Score ceiling: final score is always ≤ 100.
 *   9. Repetition-penalty cap: capped at −15.
 *  10. Consistency score: linear in active days (saturating at soft-cap).
 *  11. saturate() helper: verifiable at known points.
 *  12. Weighted sum wiring: each component contributes to the total score.
 *
 * Pattern: node:test + tsx/esm, no vitest.
 * Run: node --import tsx/esm --test src/test/creatorActivityScore.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeActivityScore,
  saturate,
  ACTIVITY_SCORE_VERSION,
  type CreatorSignals,
  CreatorSignalAggregator,
} from "../services/ranking/CreatorActivityScoreService.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function baseSignals(overrides: Partial<CreatorSignals> = {}): CreatorSignals {
  return {
    contributions24h:            0,
    contributions7d:             0,
    contributions30d:            0,
    contributions90d:            0,
    activeDays90:                0,
    participationEvents:         0,
    participationDistinctUsers:  0,
    receivedPositiveActions:     0,
    receivedInteractionVolume:            0,
    maintenanceActions:          0,
    burstEpisodes:               0,
    duplicateContentCount:       0,
    followUnfollowCycles:        0,
    rapidSameTypeCount:          0,
    eventCreateDeleteCycles:     0,
    safetyMultiplier:            1.0,
    ...overrides,
  };
}

// ─── 11. saturate() helper ────────────────────────────────────────────────────

describe("saturate()", () => {
  it("returns 0 for rawCount = 0", () => {
    assert.strictEqual(saturate(0, 20, 100), 0);
  });

  it("returns ~63% of maxPoints at rawCount = softCap", () => {
    const result = saturate(20, 20, 100);
    assert.ok(result > 60 && result < 65, `expected ~63, got ${result}`);
  });

  it("approaches 100 asymptotically — never exceeds maxPoints", () => {
    const result = saturate(1_000_000, 20, 100);
    assert.ok(result <= 100, `expected ≤ 100, got ${result}`);
    assert.ok(result > 99, `expected near 100, got ${result}`);
  });

  it("returns 0 when softCap is 0", () => {
    assert.strictEqual(saturate(10, 0, 100), 0);
  });

  it("returns 0 for negative rawCount", () => {
    assert.strictEqual(saturate(-5, 20, 100), 0);
  });
});

// ─── 1. Diminishing returns ───────────────────────────────────────────────────

describe("Diminishing returns", () => {
  it("posting 100 times does not score 100× posting once", () => {
    const single = computeActivityScore("u1", baseSignals({ contributions7d: 1, contributions90d: 1 }));
    const many   = computeActivityScore("u2", baseSignals({ contributions7d: 100, contributions90d: 100 }));
    assert.ok(
      many.score < single.score * 50,
      `many.score (${many.score}) should be < 50× single.score (${single.score})`,
    );
  });

  it("score increase from 1→10 contributions is larger than from 90→100", () => {
    const s1  = computeActivityScore("u1", baseSignals({ contributions90d: 1  }));
    const s10 = computeActivityScore("u2", baseSignals({ contributions90d: 10 }));
    const s90 = computeActivityScore("u3", baseSignals({ contributions90d: 90 }));
    const s100= computeActivityScore("u4", baseSignals({ contributions90d: 100}));

    const gain1to10   = s10.score  - s1.score;
    const gain90to100 = s100.score - s90.score;

    assert.ok(
      gain1to10 > gain90to100,
      `gain 1→10 (${gain1to10}) should exceed gain 90→100 (${gain90to100})`,
    );
  });
});

// ─── 2. Time decay ────────────────────────────────────────────────────────────

describe("Time decay", () => {
  it("same number of contributions in 24h scores higher than in 90d only", () => {
    const recent = computeActivityScore("u1", baseSignals({
      contributions24h: 5,
      contributions7d:  5,
      contributions30d: 5,
      contributions90d: 5,
    }));
    const old = computeActivityScore("u2", baseSignals({
      contributions24h: 0,
      contributions7d:  0,
      contributions30d: 0,
      contributions90d: 5,
    }));
    assert.ok(
      recent.recentContributionScore > old.recentContributionScore,
      `recent (${recent.recentContributionScore}) should > old (${old.recentContributionScore})`,
    );
  });
});

// ─── 3. Spam-penalty cap ──────────────────────────────────────────────────────

describe("Spam penalty cap", () => {
  it("spam penalty is capped at 25 regardless of inputs", () => {
    const result = computeActivityScore("u1", baseSignals({
      burstEpisodes:         100,
      duplicateContentCount: 100,
      followUnfollowCycles:  100,
      // Give a strong positive score so we can see the cap in the penalty field
      contributions7d:  20,
      contributions90d: 20,
      activeDays90:     30,
    }));
    assert.ok(
      result.spamPenalty <= 25,
      `spamPenalty (${result.spamPenalty}) should be ≤ 25`,
    );
  });

  it("low spam signals produce a spam penalty below the cap", () => {
    const result = computeActivityScore("u1", baseSignals({
      burstEpisodes:        1,
      duplicateContentCount: 1,
    }));
    assert.ok(result.spamPenalty < 25, `spamPenalty (${result.spamPenalty}) should be < 25`);
  });
});

// ─── 9. Repetition-penalty cap ────────────────────────────────────────────────

describe("Repetition penalty cap", () => {
  it("repetition penalty is capped at 15 regardless of inputs", () => {
    const result = computeActivityScore("u1", baseSignals({
      rapidSameTypeCount:      1_000,
      eventCreateDeleteCycles: 1_000,
    }));
    assert.ok(
      result.repetitionPenalty <= 15,
      `repetitionPenalty (${result.repetitionPenalty}) should be ≤ 15`,
    );
  });
});

// ─── 4. Self-engagement exclusion ────────────────────────────────────────────

describe("Self-engagement exclusion", () => {
  it("positive response score is 0 when received actions are 0 (self excluded at aggregation)", () => {
    // The aggregator excludes actor_id === userId; here we verify that
    // a score computed with zero received actions (as the aggregator would return
    // after exclusion) produces a zero positiveResponseScore.
    const result = computeActivityScore("u1", baseSignals({
      receivedPositiveActions: 0,
      receivedInteractionVolume:        1_000,
    }));
    assert.strictEqual(result.positiveResponseScore, 0);
  });
});

// ─── 5. Blocked-account exclusion ────────────────────────────────────────────

describe("Blocked-account exclusion", () => {
  it("participation from blocked accounts is excluded — signals zeroed = zero participation score", () => {
    // After the aggregator filters blocked actors, the participation counts drop
    // to 0; verify the formula returns 0 community participation score for that.
    const result = computeActivityScore("u1", baseSignals({
      participationEvents:        0,
      participationDistinctUsers: 0,
    }));
    assert.strictEqual(result.communityParticipationScore, 0);
  });
});

// ─── 6. Safety-multiplier collapse ───────────────────────────────────────────

describe("Safety multiplier", () => {
  it("multiplier 0.0 collapses the final score to 0", () => {
    const result = computeActivityScore("u1", baseSignals({
      contributions7d:             10,
      contributions90d:            50,
      activeDays90:                60,
      participationEvents:         20,
      participationDistinctUsers:  10,
      receivedPositiveActions:     30,
      receivedInteractionVolume:            200,
      safetyMultiplier:            0.0,
    }));
    assert.strictEqual(result.score, 0, `score should be 0 with safety multiplier 0.0, got ${result.score}`);
  });

  it("multiplier 1.0 does not reduce the score", () => {
    const base    = computeActivityScore("u1", baseSignals({ contributions7d: 5, contributions90d: 10, safetyMultiplier: 1.0 }));
    const reduced = computeActivityScore("u2", baseSignals({ contributions7d: 5, contributions90d: 10, safetyMultiplier: 0.5 }));
    assert.ok(base.score >= reduced.score, `full multiplier (${base.score}) should be ≥ halved (${reduced.score})`);
  });

  it("partial multiplier (0.5) halves the effective score", () => {
    // Build a scenario with well-known positive signals and no penalties.
    const signals = baseSignals({
      contributions7d:             10,
      contributions30d:            10,
      contributions90d:            10,
      activeDays90:                20,
    });
    const full = computeActivityScore("u1", { ...signals, safetyMultiplier: 1.0 });
    const half = computeActivityScore("u2", { ...signals, safetyMultiplier: 0.5 });
    // half.score should be approximately full.score * 0.5 (within rounding)
    const ratio = half.score / Math.max(full.score, 0.01);
    assert.ok(
      Math.abs(ratio - 0.5) < 0.05,
      `ratio (${ratio}) should be ~0.5`,
    );
  });
});

// ─── 7. New-user with zero history ────────────────────────────────────────────

describe("New user base score", () => {
  it("a new user with zero history scores above zero (not zero)", () => {
    const result = computeActivityScore("u-new", baseSignals());
    assert.ok(result.score > 0, `new user score should be > 0, got ${result.score}`);
  });

  it("new user score is in the middle range (not maxed out)", () => {
    const result = computeActivityScore("u-new", baseSignals());
    assert.ok(result.score < 50, `new user score (${result.score}) should be < 50`);
  });
});

// ─── 8. Score ceiling ─────────────────────────────────────────────────────────

describe("Score ceiling", () => {
  it("score is always ≤ 100 even with extreme positive inputs", () => {
    const result = computeActivityScore("u1", baseSignals({
      contributions24h:            1_000,
      contributions7d:             1_000,
      contributions30d:            1_000,
      contributions90d:            1_000,
      activeDays90:                90,
      participationEvents:         1_000,
      participationDistinctUsers:  500,
      receivedPositiveActions:     10_000,
      receivedInteractionVolume:            100,
      maintenanceActions:          1_000,
      safetyMultiplier:            1.0,
    }));
    assert.ok(result.score <= 100, `score (${result.score}) should be ≤ 100`);
  });
});

// ─── 10. Consistency score ────────────────────────────────────────────────────

describe("Consistency score", () => {
  it("0 active days → 0 consistency score", () => {
    const result = computeActivityScore("u1", baseSignals({ activeDays90: 0 }));
    assert.strictEqual(result.consistencyScore, 0);
  });

  it("30 active days scores higher than 10 active days", () => {
    const r10 = computeActivityScore("u1", baseSignals({ activeDays90: 10 }));
    const r30 = computeActivityScore("u2", baseSignals({ activeDays90: 30 }));
    assert.ok(r30.consistencyScore > r10.consistencyScore);
  });

  it("90 active days saturates below 100 but approaches it", () => {
    const r90 = computeActivityScore("u1", baseSignals({ activeDays90: 90 }));
    assert.ok(r90.consistencyScore > 90, `expected > 90, got ${r90.consistencyScore}`);
    assert.ok(r90.consistencyScore <= 100);
  });
});

// ─── 12. Component wiring ─────────────────────────────────────────────────────

describe("Component wiring", () => {
  it("positive response score is 0 for zero received actions", () => {
    const result = computeActivityScore("u1", baseSignals({ receivedPositiveActions: 0 }));
    assert.strictEqual(result.positiveResponseScore, 0);
  });

  it("positive response score is non-zero for real received actions", () => {
    const result = computeActivityScore("u1", baseSignals({
      receivedPositiveActions: 20,
      receivedInteractionVolume:        100,
    }));
    assert.ok(result.positiveResponseScore > 0, `expected > 0, got ${result.positiveResponseScore}`);
  });

  it("maintenance score is 0 with no maintenance actions", () => {
    const result = computeActivityScore("u1", baseSignals());
    assert.strictEqual(result.maintenanceScore, 0);
  });

  it("maintenance score is non-zero with maintenance actions", () => {
    const result = computeActivityScore("u1", baseSignals({ maintenanceActions: 5 }));
    assert.ok(result.maintenanceScore > 0, `expected > 0, got ${result.maintenanceScore}`);
  });

  it("calculationVersion matches ACTIVITY_SCORE_VERSION constant", () => {
    const result = computeActivityScore("u1", baseSignals());
    assert.strictEqual(result.calculationVersion, ACTIVITY_SCORE_VERSION);
  });

  it("userId is preserved on the result", () => {
    const result = computeActivityScore("my-user-id-123", baseSignals());
    assert.strictEqual(result.userId, "my-user-id-123");
  });
});

// ─── Combined scenario ────────────────────────────────────────────────────────

describe("Combined scenario", () => {
  it("an active creator with moderate signals scores above 20", () => {
    const result = computeActivityScore("u-active", baseSignals({
      contributions24h:            2,
      contributions7d:             8,
      contributions30d:            20,
      contributions90d:            45,
      activeDays90:                35,
      participationEvents:         15,
      participationDistinctUsers:  8,
      receivedPositiveActions:     30,
      receivedInteractionVolume:            500,
      maintenanceActions:          3,
      safetyMultiplier:            1.0,
    }));
    assert.ok(result.score > 20, `active creator score (${result.score}) should be > 20`);
    assert.ok(result.score <= 100, `active creator score (${result.score}) should be ≤ 100`);
  });

  it("a spammy creator with high burst episodes scores lower than a clean one", () => {
    const clean = computeActivityScore("u-clean", baseSignals({
      contributions7d:  5,
      contributions90d: 20,
      activeDays90:     20,
    }));
    const spammy = computeActivityScore("u-spammy", baseSignals({
      contributions7d:       5,
      contributions90d:      20,
      activeDays90:          20,
      burstEpisodes:         5,
      duplicateContentCount: 5,
      followUnfollowCycles:  5,
    }));
    assert.ok(
      spammy.score < clean.score,
      `spammy (${spammy.score}) should be < clean (${clean.score})`,
    );
  });
});

// ─── CreatorSignalAggregator — fake-DB tests ──────────────────────────────────
//
// These tests drive the aggregator through a minimal fake Supabase client to
// verify that blocked-account exclusion and self-engagement exclusion are
// enforced at the aggregation layer, not just at the formula layer.

const CREATOR_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const FRIEND_ID  = "bbbbbbbb-0000-4000-8000-000000000002";
const BLOCKED_ID = "cccccccc-0000-4000-8000-000000000003";
const ago91d     = new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000).toISOString();
const ago1d      = new Date(Date.now() - 1  * 24 * 60 * 60 * 1_000 + 60_000).toISOString();

/**
 * Minimal fake Supabase builder.  Each from() call returns a chainable object
 * whose `.then()` resolves to `{ data: tableData[table] ?? [], error: null }`.
 * Tables not present in tableData return an empty array.
 */
function makeFakeDb(tableData: Record<string, any[]>) {
  function buildChain(table: string) {
    let _single = false;
    let _maybeSingle = false;
    const filters: Array<(r: any) => boolean> = [];
    const chain: any = {
      select()          { return chain; },
      eq(col: string, val: any)   { filters.push((r) => r[col] === val); return chain; },
      neq(col: string, val: any)  { filters.push((r) => r[col] !== val); return chain; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return chain; },
      gte(col: string, val: any)  { filters.push((r) => r[col] >= val); return chain; },
      // `.is(col, null)` — needed by the soft-delete filter on posts_comments.
      // It was ABSENT, and its absence did not throw where the caller could see
      // it: the aggregator's per-source try/catch turned the TypeError into an
      // empty result, so the component read 0 and the test failed for a reason
      // that had nothing to do with the code under test. A double that lacks an
      // operator silently is the same class of defect as one that ignores
      // `.select()` — cf. fakeMapDb, which THROWS on an unimplemented operator
      // rather than answering "no rows".
      is(col: string, val: any)   { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return chain; },
      or()              { return chain; },
      order()           { return chain; },
      limit()           { return chain; },
      maybeSingle()     { _maybeSingle = true; return chain; },
      single()          { _single = true; return chain; },
      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          const rows = (tableData[table] ?? []).filter((r) => filters.every((f) => f(r)));
          const data = _single || _maybeSingle ? (rows[0] ?? null) : rows;
          return resolve({ data, error: null });
        }).catch(reject);
      },
    };
    return chain;
  }
  return { from: (t: string) => buildChain(t) };
}

describe("CreatorSignalAggregator — blocked-account exclusion", () => {
  it("participation from a blocked user is not counted", async () => {
    // BLOCKED_ID is in the blocks table (creator blocked them).
    // They also posted a comment on others' content via the creator's actor_id
    // (simulated below) — but more importantly, they are the content owner
    // that the creator would have interacted with.
    const db = makeFakeDb({
      blocks: [
        { blocker_id: CREATOR_ID, blocked_id: BLOCKED_ID },
      ],
      // The creator commented on two people's posts. Ownership is resolved
      // through `posts`, so the post rows ARE the fixture — a comment whose
      // post has no owner row cannot be attributed and must not be counted.
      posts_comments: [
        { user_id: CREATOR_ID, post_id: "p-friend",  deleted_at: null, created_at: ago1d },
        { user_id: CREATOR_ID, post_id: "p-blocked", deleted_at: null, created_at: ago1d },
      ],
      posts: [
        { id: "p-friend",  author_id: FRIEND_ID,  status: "active", created_at: ago1d },
        { id: "p-blocked", author_id: BLOCKED_ID, status: "active", created_at: ago1d },
      ],
      event_rsvps: [],
      events: [], trips: [], reviews: [], discovery_places: [],
      trust_profiles: [],
    });

    const agg = new CreatorSignalAggregator(db as any);
    const signals = await agg.aggregate(CREATOR_ID);

    // Only the FRIEND row should remain after blocked-account exclusion.
    assert.strictEqual(
      signals.participationEvents, 1,
      `expected 1 participation event (blocked user excluded), got ${signals.participationEvents}`,
    );
    assert.strictEqual(
      signals.participationDistinctUsers, 1,
      `expected 1 distinct user, got ${signals.participationDistinctUsers}`,
    );
  });

  it("positive responses from a blocked actor are not counted", async () => {
    const db = makeFakeDb({
      blocks: [
        { blocker_id: BLOCKED_ID, blocked_id: CREATOR_ID }, // blocked_by direction
      ],
      // Two people saved the creator's post. Received signals are joined on the
      // creator's OWN post ids, so the post row is what makes them attributable.
      post_saves: [
        { user_id: FRIEND_ID,  post_id: "p-mine", created_at: ago1d },
        { user_id: BLOCKED_ID, post_id: "p-mine", created_at: ago1d },
      ],
      posts: [{ id: "p-mine", author_id: CREATOR_ID, status: "active", created_at: ago1d }],
      events: [], trips: [], reviews: [], discovery_places: [],
      trust_profiles: [],
    });

    const agg = new CreatorSignalAggregator(db as any);
    const signals = await agg.aggregate(CREATOR_ID);

    assert.strictEqual(
      signals.receivedPositiveActions, 1,
      `expected 1 positive action (blocked actor excluded), got ${signals.receivedPositiveActions}`,
    );
  });
});

describe("CreatorSignalAggregator — self-engagement exclusion", () => {
  it("self-actions (actor_id = creator) do not count as positive responses", async () => {
    const db = makeFakeDb({
      blocks: [],
      // A self-save is a REAL possibility on the first-class tables: unlike
      // routes/mediaFeed.ts, routes/posts.ts has no self-stamp/self-save guard,
      // so the exclusion has to live in the aggregator — which is what this
      // asserts. Under activity_events it was hypothetical; now it is reachable.
      post_saves: [
        { user_id: CREATOR_ID, post_id: "p-mine", created_at: ago1d },
        { user_id: FRIEND_ID,  post_id: "p-mine", created_at: ago1d },
      ],
      posts: [{ id: "p-mine", author_id: CREATOR_ID, status: "active", created_at: ago1d }],
      events: [], trips: [], reviews: [], discovery_places: [],
      trust_profiles: [],
    });

    const agg = new CreatorSignalAggregator(db as any);
    const signals = await agg.aggregate(CREATOR_ID);

    assert.strictEqual(
      signals.receivedPositiveActions, 1,
      `expected 1 (self-save excluded), got ${signals.receivedPositiveActions}`,
    );
  });
});

describe("CreatorSignalAggregator — end-to-end signal wiring", () => {
  it("aggregate() produces non-zero signals for an active creator", async () => {
    const db = makeFakeDb({
      blocks: [],
      // Every lane is now fed by a table that has a real production writer.
      // This is the end-to-end control for the whole rewrite: if any component
      // silently returns to zero, one of the four assertions below fails.
      posts_comments: [{ user_id: CREATOR_ID, post_id: "p-theirs", deleted_at: null, created_at: ago1d }],
      post_saves:     [{ user_id: FRIEND_ID,  post_id: "p-mine",   created_at: ago1d }],
      event_rsvps:    [],
      // One published post in the 90d window.
      // Real column shape: posts.status is public.post_status
      // ('active','hidden','reported','deleted') and posts.post_status is
      // public.delayed_post_status (…,'published',…). This fixture previously
      // carried status:"published" — a value the real enum cannot hold — which
      // matched the service's then-broken .eq("status","published") predicate
      // and so kept this test green over a query that returned nothing in
      // production. See creatorActivityEnumLiterals.test.ts.
      posts: [
        { id: "p-mine",   author_id: CREATOR_ID, status: "active", post_status: "published", created_at: ago1d },
        // Someone else's post, so the creator's comment on it is participation.
        { id: "p-theirs", author_id: FRIEND_ID,  status: "active", post_status: "published", created_at: ago1d },
      ],
      events: [], trips: [], reviews: [], discovery_places: [],
      trust_profiles: [{ user_id: CREATOR_ID, overall_score: 75, public_level: "trusted_traveler" }],
    });

    const agg = new CreatorSignalAggregator(db as any);
    const signals = await agg.aggregate(CREATOR_ID);

    assert.ok(signals.contributions90d >= 1, "expected ≥1 contribution from the post");
    assert.ok(signals.activeDays90    >= 1, "expected ≥1 active day");
    assert.ok(signals.participationEvents >= 1, "expected ≥1 participation event");
    assert.ok(signals.receivedPositiveActions >= 1, "expected ≥1 positive response");
    assert.strictEqual(signals.safetyMultiplier, 1.0, "trusted_traveler should have full multiplier");
  });

  it("aggregate() scores a user with blocked actors lower than the same user without blocked actors", async () => {
    // Without blocked actors: FRIEND save counts
    const dbClean = makeFakeDb({
      blocks: [],
      post_saves: [{ user_id: FRIEND_ID, post_id: "p-mine", created_at: ago1d }],
      posts: [{ id: "p-mine", author_id: CREATOR_ID, status: "active", created_at: ago1d }],
      events: [], trips: [], reviews: [], discovery_places: [],
      trust_profiles: [],
    });

    // With blocked actors: BLOCKED_ID save should be stripped
    const dbBlocked = makeFakeDb({
      blocks: [{ blocker_id: CREATOR_ID, blocked_id: BLOCKED_ID }],
      post_saves: [
        // Same FRIEND save
        { user_id: FRIEND_ID,  post_id: "p-mine", created_at: ago1d },
        // Extra saves from a blocked user — must not inflate the score. Three of
        // them, so a filter that silently stopped working would be visible as a
        // score difference rather than a rounding wobble.
        { user_id: BLOCKED_ID, post_id: "p-mine", created_at: ago1d },
        { user_id: BLOCKED_ID, post_id: "p-mine", created_at: ago1d },
        { user_id: BLOCKED_ID, post_id: "p-mine", created_at: ago1d },
      ],
      posts: [{ id: "p-mine", author_id: CREATOR_ID, status: "active", created_at: ago1d }],
      events: [], trips: [], reviews: [], discovery_places: [],
      trust_profiles: [],
    });

    const [sigsClean, sigsBlocked] = await Promise.all([
      new CreatorSignalAggregator(dbClean   as any).aggregate(CREATOR_ID),
      new CreatorSignalAggregator(dbBlocked as any).aggregate(CREATOR_ID),
    ]);

    // After exclusion the blocked DB should produce the same positive-action
    // count as the clean one (blocked saves stripped).
    assert.strictEqual(
      sigsBlocked.receivedPositiveActions,
      sigsClean.receivedPositiveActions,
      `blocked saves must be excluded: clean=${sigsClean.receivedPositiveActions}, blocked=${sigsBlocked.receivedPositiveActions}`,
    );
  });
});

// ─── The admin tier boundaries are reachable ─────────────────────────────────

/**
 * adminRankingMetrics.bucketScoreToTier splits creators at 21 / 41 / 66 / 86.
 * Those boundaries were written for the 0-100 design. They were FICTION until
 * 2026-09-06: four of the five components read `activity_events`, a table with
 * no producer, so 0.70 of the weight was structurally zero and the reachable
 * ceiling was about 30. Every creator in every environment bucketed to
 * new_inactive or occasional, and the top three tiers could not be occupied by
 * any input whatsoever.
 *
 * This is the aggregate counterpart to the per-component mutation proof: a
 * component that silently returns to zero drops the ceiling back under a
 * boundary, and this test is what notices. It asserts REACHABILITY, not any
 * particular creator's score.
 *
 * NOTE ON THE INPUTS: the contribution windows are CUMULATIVE, and
 * weightedContributionScore saturates each window's MARGINAL count
 * (c7d - c24h, and so on) against SOFT_CAP_CONTRIBUTION = 20. So a creator with
 * 200 posts in 90d but only 5 in the last day scores ~52 on that component, not
 * ~100 — the marginals, not the totals, are what saturate. Building these
 * fixtures from totals is an easy way to write a test that fails against
 * perfectly good code; it is what the first draft of this test did.
 */
describe("activity tiers — the admin dashboard's boundaries are occupiable", () => {
  /** Cumulative windows carrying `perWindow` NEW contributions in each band. */
  const withMarginals = (perWindow: number, rest: Partial<CreatorSignals>): CreatorSignals =>
    baseSignals({
      contributions24h: perWindow,
      contributions7d:  perWindow * 2,
      contributions30d: perWindow * 3,
      contributions90d: perWindow * 4,
      ...rest,
    });

  const MAXED = withMarginals(100, {
    activeDays90: 90,
    participationEvents: 120, participationDistinctUsers: 90,
    receivedPositiveActions: 400, receivedInteractionVolume: 400,
    maintenanceActions: 60,
  });

  it("a maximally active creator reaches highly_active (>= 86)", () => {
    const { score } = computeActivityScore("max", MAXED);
    assert.ok(
      score >= 86,
      `a creator maxed on every component scores ${score}, below the highly_active ` +
        `boundary of 86. Some component is returning zero for inputs that should ` +
        `saturate it — that is how this lane died the first time. Check which of ` +
        `the five reads is empty before adjusting the boundary.`,
    );
  });

  it("scales monotonically with activity, and spans from below moderate to the top tier", () => {
    const at = (m: number) =>
      computeActivityScore("s", withMarginals(Math.max(0, Math.round(100 * m)), {
        activeDays90:               Math.round(90 * m),
        participationEvents:        Math.round(120 * m),
        participationDistinctUsers: Math.round(90 * m),
        receivedPositiveActions:    Math.round(400 * m),
        receivedInteractionVolume:  Math.round(400 * m),
        maintenanceActions:         Math.round(60 * m),
      })).score;

    const scores = [0.002, 0.02, 0.1, 1.0].map(at);
    for (let i = 1; i < scores.length; i++) {
      assert.ok(
        scores[i]! > scores[i - 1]!,
        `score is not monotonic in activity: ${JSON.stringify(scores)}. A component ` +
          `that ignores its input entirely produces exactly this flatness.`,
      );
    }
    assert.ok(scores[0]! < 41, `lowest sample ${scores[0]} should sit under moderate`);
    assert.ok(scores[3]! >= 86, `highest sample ${scores[3]} should reach highly_active`);
  });
});

// ─── Owner lookup is chunked ─────────────────────────────────────────────────

/**
 * A double that fails the way PostgREST fails on an over-long query string.
 *
 * The ordinary makeFakeDb `.in()` accepts a list of any size, so it is
 * structurally incapable of catching an unchunked lookup — the same blindness
 * that let the original `activity_events` reads look healthy. This double
 * refuses any `.in()` above the limit, which is what a 414 does in practice.
 */
function makeUrlLimitedDb(tableData: Record<string, any[]>, maxInSize: number) {
  let rejections = 0;
  function buildChain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let refused = false;
    const chain: any = {
      select() { return chain; },
      eq(c: string, v: any)  { filters.push((r) => r[c] === v); return chain; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return chain; },
      gte(c: string, v: any) { filters.push((r) => r[c] >= v); return chain; },
      is(c: string, v: any)  { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return chain; },
      or() { return chain; }, order() { return chain; }, limit() { return chain; },
      maybeSingle() { return chain; }, single() { return chain; },
      in(c: string, vals: any[]) {
        if (vals.length > maxInSize) { refused = true; rejections++; return chain; }
        filters.push((r) => vals.includes(r[c]));
        return chain;
      },
      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          // supabase-js RETURNS the error; it does not throw. A caller that only
          // guards with try/catch sees `data === undefined`, not an exception.
          if (refused) return resolve({ data: undefined, error: { code: "414", message: "URI too long" } });
          return resolve({ data: (tableData[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
        }).catch(reject);
      },
    };
    return chain;
  }
  return { db: { from: (t: string) => buildChain(t) }, rejections: () => rejections };
}

describe("CreatorSignalAggregator — owner lookup survives a large id set", () => {
  const CREATOR = "22222222-2222-4222-8222-222222222222";
  const uuid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
  const N = 250; // > OWNER_LOOKUP_CHUNK (100), so it must span 3 requests

  it("counts participation for a prolific commenter instead of silently reading zero", async () => {
    const authors = Array.from({ length: N }, (_, i) => uuid(i + 1));
    const { db, rejections } = makeUrlLimitedDb({
      blocks: [],
      posts_comments: authors.map((_, i) => ({
        user_id: CREATOR, post_id: `post-${i}`, deleted_at: null, created_at: "2026-09-01T00:00:00Z",
      })),
      posts: authors.map((a, i) => ({ id: `post-${i}`, author_id: a })),
      event_rsvps: [],
      events: [],
    }, 100);

    const agg = new CreatorSignalAggregator(db as any);
    const signals = await agg.aggregate(CREATOR);

    assert.equal(
      rejections(), 0,
      `the owner lookup sent an .in() larger than the limit ${rejections()} time(s). ` +
        `Against a real PostgREST that is a 414 which supabase-js RETURNS rather ` +
        `than throws, so the component reads 0 for precisely the most active ` +
        `participants — silently, and only above a size threshold no fixture hits.`,
    );
    assert.equal(signals.participationEvents, N, "every comment's owner should resolve");
    assert.equal(signals.participationDistinctUsers, N, "all owners are distinct");
  });
});

// ─── Every .in() on a built list is chunked, not just the owner lookup ───────

/**
 * The owner lookup was chunked first, and the four reads in
 * _fetchPositiveResponses were left with an unbounded list — the same 414, the
 * same silent zero, on the component weighted 0.20. A repo-wide sweep found it
 * afterwards. This test covers ALL of them so the next one cannot slip through:
 * the double refuses any `.in()` above the limit exactly as PostgREST does.
 */
describe("CreatorSignalAggregator — no unbounded .in() reaches the database", () => {
  const CREATOR = "44444444-4444-4444-8444-444444444444";
  const post = (n: number) => `post-${n}`;
  const actor = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`;
  const N = 260; // > IN_LIST_CHUNK (100), so every read must span 3 requests

  it("counts engagement for a prolific creator instead of silently reading zero", async () => {
    const posts = Array.from({ length: N }, (_, i) => ({
      id: post(i), author_id: CREATOR, status: "active",
      post_status: "published", created_at: "2026-09-01T00:00:00Z",
    }));
    const savers = Array.from({ length: N }, (_, i) => ({
      user_id: actor(i), post_id: post(i), created_at: "2026-09-02T00:00:00Z",
    }));

    const { db, rejections } = makeUrlLimitedDb({
      blocks: [],
      posts,
      post_saves: savers,
      post_shares: [],
      posts_comments: [],
      user_follows: [],
      content_stamps: [],
      post_edits: [],
      profile_views: [],
      events: [],
      trips: [],
      reviews: [],
      discovery_places: [],
      event_rsvps: [],
      trust_profiles: [],
    }, 100);

    const agg = new CreatorSignalAggregator(db as any);
    const signals = await agg.aggregate(CREATOR);

    assert.equal(
      rejections(), 0,
      `${rejections()} read(s) sent an .in() larger than the limit. Against a real ` +
        `PostgREST that is a 414 which supabase-js RETURNS rather than throws, so the ` +
        `component reads 0 for exactly the most prolific creators — and the more they ` +
        `post, the more certain the zero.`,
    );
    assert.ok(
      signals.receivedPositiveActions >= N,
      `expected at least ${N} received actions, got ${signals.receivedPositiveActions}`,
    );
  });
});
