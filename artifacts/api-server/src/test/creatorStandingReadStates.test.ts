/**
 * creatorStandingReadStates.test.ts
 *
 * Two defects from docs/architecture/12 §3.3, both of the same family: a read
 * that could fail, could come back empty, or could come back with a row, and
 * code that had only one answer for all three.
 *
 * C3 — THE SAFETY MULTIPLIER (07 §5; PRs #458 and #449)
 *   `CreatorActivityScoreService._fetchSafetyMultiplier` ended
 *       catch { return 1.0; // fail-open: don't penalise on DB error }
 *   The multiplier is a VETO: `trust_profiles.overall_score < 20` collapses a
 *   creator's whole score to zero. Defaulting an unreadable veto to 1.0 is not
 *   "no opinion", it is the most permissive opinion — and `persistActivityScore`
 *   then UPSERTs it with a fresh `calculated_at` claiming it had been measured.
 *
 *   #458's rule: a failed read must never be reported as empty, clean or done —
 *   the trust scorer THROWS `TrustInputUnavailableError` rather than
 *   substituting defaults, because an exception is the only signal its call
 *   sites act on. This lane now does the same thing with the same shape, and
 *   the honest posture 07 §5 names is to SKIP THE CREATOR THIS PASS.
 *
 *   #449's rule, which pulls the other way and must not be broken by the fix:
 *   a user with NO `trust_profiles` row has no earned trust, and row-absence is
 *   the canonical representation of that. Absence is the COMMON case, and an
 *   unmeasured person must NOT be de-ranked. So: absent -> 1.0, unreadable ->
 *   skip. Every unavailable-state test below is paired with an absent-state
 *   CONTROL, because a fix that turned absence into a skip would be a worse
 *   defect than the one being repaired.
 *
 * C2 — ROW-ABSENT vs SCORE-ZERO (07 D3)
 *   `DiscoveryRankingService` defaulted a missing `creator_activity_scores` row
 *   to `{ score: 0 }` while `lib/creatorActivityScoreScheduler.ts` deliberately
 *   seeds a floor-10 row for every profile, its own comment saying the two
 *   produce different downstream boosts. The consumer now resolves three states
 *   and a measured 0 is no longer the same input as no row at all.
 *
 *   This is INERT TODAY on purpose: `calcActivityBoost` is monotonic, so both
 *   still yield a boost of 0, and `ACTIVITY_DISCOVERY_BOOST_ENABLED` is off.
 *   The inertness is asserted rather than assumed — see the last describe block.
 *
 * Runtime: node:test + node:assert (NOT vitest).
 * Run: pnpm --filter @workspace/api-server test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CreatorSignalAggregator,
  CreatorTrustInputUnavailableError,
  calculateAndPersistScore,
  computeActivityScore,
  type CreatorSignals,
} from "../services/ranking/CreatorActivityScoreService.js";
import {
  batchLoadActivityScores,
  resolveCreatorActivity,
  rankItems,
  type CreatorActivityRow,
  type RankingInput,
  type RankingViewerContext,
} from "../services/ranking/DiscoveryRankingService.js";

const CREATOR = "aaaaaaaa-0000-4000-8000-0000000000c1";
const OTHER   = "bbbbbbbb-0000-4000-8000-0000000000c2";

// ─── C3: a fake DB whose trust_profiles read can be told what to do ──────────

type TrustMode =
  | { kind: "row"; overallScore: number }
  | { kind: "absent" }
  | { kind: "error"; message: string }
  | { kind: "throw" };

interface TrustDb {
  db: any;
  upserts: Array<Record<string, unknown>>;
}

/**
 * Minimal chainable double. Every table but `trust_profiles` answers "no rows"
 * — the point here is the trust lane, and an empty activity set is a legitimate
 * answer for a creator with no content. `creator_activity_scores.upsert` is
 * recorded so the suite can assert what was (and was not) WRITTEN, which is the
 * whole claim: when the input cannot be read, write nothing.
 */
function makeTrustDb(mode: TrustMode): TrustDb {
  const upserts: Array<Record<string, unknown>> = [];

  function chain(table: string): any {
    let single = false;
    const c: any = {
      select: () => c,
      eq: () => c,
      neq: () => c,
      in: () => c,
      gt: () => c,
      gte: () => c,
      lt: () => c,
      is: () => c,
      or: () => c,
      order: () => c,
      limit: () => c,
      maybeSingle: () => { single = true; return c; },
      single: () => { single = true; return c; },
      upsert: (row: Record<string, unknown>) => {
        upserts.push(row);
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolveFn: any, rejectFn: any) =>
        Promise.resolve()
          .then(() => {
            if (table === "trust_profiles") {
              if (mode.kind === "throw") throw new Error("socket hang up");
              if (mode.kind === "error")  return resolveFn({ data: null, error: { message: mode.message } });
              if (mode.kind === "absent") return resolveFn({ data: null, error: null });
              return resolveFn({ data: { overall_score: mode.overallScore }, error: null });
            }
            return resolveFn({ data: single ? null : [], error: null });
          })
          .catch(rejectFn),
    };
    return c;
  }

  return { db: { from: (t: string) => chain(t) }, upserts };
}

describe("C3 — the safety multiplier has three states, not one", () => {
  it("CONTROL: a readable row maps through the numeric rungs unchanged", async () => {
    for (const [score, expected] of [[15, 0.0], [25, 0.3], [35, 0.6], [45, 0.8], [55, 1.0]] as const) {
      const { db } = makeTrustDb({ kind: "row", overallScore: score });
      const signals = await new CreatorSignalAggregator(db).aggregate(CREATOR);
      assert.equal(signals.safetyMultiplier, expected, `overall_score ${score}`);
    }
  });

  it("CONTROL (#449): NO trust_profiles row keeps the full multiplier and is not a failure", async () => {
    const { db } = makeTrustDb({ kind: "absent" });
    const signals = await new CreatorSignalAggregator(db).aggregate(CREATOR);
    assert.equal(
      signals.safetyMultiplier, 1.0,
      "row-absence is the canonical representation of 'no earned trust' (#449). " +
        "An unmeasured person must not be de-ranked — do not turn this into a skip.",
    );
  });

  it("an UNREADABLE trust_profiles throws CreatorTrustInputUnavailableError instead of returning 1.0", async () => {
    const { db } = makeTrustDb({ kind: "error", message: "permission denied for table trust_profiles" });
    await assert.rejects(
      () => new CreatorSignalAggregator(db).aggregate(CREATOR),
      (err: unknown) => {
        assert.ok(
          err instanceof CreatorTrustInputUnavailableError,
          `expected CreatorTrustInputUnavailableError, got ${String(err)}`,
        );
        assert.equal((err as CreatorTrustInputUnavailableError).userId, CREATOR);
        assert.match((err as CreatorTrustInputUnavailableError).reason, /permission denied/);
        return true;
      },
      "supabase-js RESOLVES on a failed query, so a dropped `error` used to arrive " +
        "as `data: null` and read exactly like 'this creator has no trust profile'",
    );
  });

  it("a THROWN client is the same 'could not read', not evidence the creator is safe", async () => {
    const { db } = makeTrustDb({ kind: "throw" });
    await assert.rejects(
      () => new CreatorSignalAggregator(db).aggregate(CREATOR),
      CreatorTrustInputUnavailableError,
    );
  });
});

describe("C3 — skipping the creator means WRITING NOTHING", () => {
  it("an unreadable trust input persists no row and returns null", async () => {
    const { db, upserts } = makeTrustDb({ kind: "error", message: "read failed" });
    const result = await calculateAndPersistScore(db, CREATOR);

    assert.equal(result, null, "the caller must be told nothing was produced");
    assert.deepEqual(
      upserts, [],
      "a score was UPSERTed into creator_activity_scores from an input that failed to " +
        "load. That row carries a fresh calculated_at asserting it had just been " +
        "measured — the fabricated-measurement failure #458 exists to end.",
    );
  });

  it("CONTROL: a readable trust input DOES persist, so the guard is not blocking everything", async () => {
    const { db, upserts } = makeTrustDb({ kind: "row", overallScore: 80 });
    const result = await calculateAndPersistScore(db, CREATOR);

    assert.ok(result, "a creator whose inputs all read must still be scored");
    assert.equal(upserts.length, 1, "exactly one row written");
    assert.equal((upserts[0] as any).user_id, CREATOR);
    assert.equal((upserts[0] as any).safety_multiplier, 1.0);
  });

  it("CONTROL (#449): an ABSENT trust row still persists — absence is not a skip", async () => {
    const { db, upserts } = makeTrustDb({ kind: "absent" });
    const result = await calculateAndPersistScore(db, CREATOR);

    assert.ok(result, "a creator with no trust profile must still be scored");
    assert.equal(upserts.length, 1);
    assert.equal(
      (upserts[0] as any).safety_multiplier, 1.0,
      "the veto only ever fires for users who HAVE evidence (#449)",
    );
  });

  it("the skip leaves the creator's existing row untouched rather than replacing it", async () => {
    // There is no update, no delete and no upsert on any table when the trust
    // read fails — a stale row is a known-old measurement and survives.
    const { db, upserts } = makeTrustDb({ kind: "error", message: "boom" });
    await calculateAndPersistScore(db, CREATOR);
    await calculateAndPersistScore(db, OTHER);
    assert.deepEqual(upserts, []);
  });

  it("the error names the creator and the reason, so a skipped pass is accountable", () => {
    const err = new CreatorTrustInputUnavailableError(CREATOR, "permission denied");
    assert.equal(err.name, "CreatorTrustInputUnavailableError");
    assert.equal(err.userId, CREATOR);
    assert.equal(err.reason, "permission denied");
    assert.match(err.message, /refusing to score this pass/);
    assert.ok(err instanceof Error, "must be catchable as an Error by the scheduler");
  });
});

// ─── C2: row-absent vs score-zero vs unreadable ──────────────────────────────

/** A fake supabase client for one `creator_activity_scores` batch read. */
function makeScoresDb(res: { data?: any[] | null; error?: any } | "throw"): any {
  return {
    from: () => {
      if (res === "throw") return { select: () => { throw new Error("no such table"); } };
      const chain: any = {
        select: () => chain,
        in: () => Promise.resolve({ data: res.data ?? null, error: res.error ?? null }),
      };
      return chain;
    },
  };
}

describe("C2 — batchLoadActivityScores separates 'no rows' from 'could not read'", () => {
  it("returns the rows that exist, and unavailable = false", async () => {
    const db = makeScoresDb({ data: [{ user_id: CREATOR, score: 42, spam_penalty: 3 }] });
    const out = await batchLoadActivityScores(db, [CREATOR, OTHER]);
    assert.equal(out.unavailable, false);
    assert.deepEqual(out.scores.get(CREATOR), { score: 42, spam_penalty: 3 });
    assert.equal(out.scores.has(OTHER), false, "a creator with no row must not be invented");
  });

  it("CONTROL: a genuinely empty result is an ANSWER — unavailable stays false", async () => {
    const db = makeScoresDb({ data: [] });
    const out = await batchLoadActivityScores(db, [CREATOR]);
    assert.equal(out.unavailable, false, "nobody scored yet is a fact, not a failure");
    assert.equal(out.scores.size, 0);
  });

  it("a FAILED read reports unavailable rather than 'nobody in this batch is scored'", async () => {
    const db = makeScoresDb({ data: null, error: { message: "permission denied" } });
    const out = await batchLoadActivityScores(db, [CREATOR, OTHER]);
    assert.equal(
      out.unavailable, true,
      "without binding `error`, one failed read makes every creator in the batch look unscored",
    );
    assert.equal(out.scores.size, 0);
  });

  it("a throwing client is also unavailable, not empty", async () => {
    const out = await batchLoadActivityScores(makeScoresDb("throw"), [CREATOR]);
    assert.equal(out.unavailable, true);
  });

  it("no db and no creators are answered without a read at all", async () => {
    assert.equal((await batchLoadActivityScores(null, [CREATOR])).unavailable, false);
    assert.equal((await batchLoadActivityScores(makeScoresDb({ data: [] }), [])).unavailable, false);
  });
});

describe("C2 — resolveCreatorActivity: a measured 0 is not an absent row (07 D3)", () => {
  const measuredZero = new Map<string, CreatorActivityRow>([
    [CREATOR, { score: 0, spam_penalty: 0 }],
  ]);

  it("a creator WITH a row scoring 0 is `measured`", () => {
    const r = resolveCreatorActivity(measuredZero, CREATOR, false);
    assert.equal(r.state, "measured");
    assert.equal(r.state === "measured" ? r.row.score : null, 0);
  });

  it("a creator with NO row is `unscored`, and the two are distinguishable", () => {
    const absent   = resolveCreatorActivity(measuredZero, OTHER, false);
    const measured = resolveCreatorActivity(measuredZero, CREATOR, false);
    assert.equal(absent.state, "unscored");
    assert.notEqual(
      absent.state, measured.state,
      "row-absent and score-zero must be different answers. The scheduler seeds a " +
        "floor-10 row for EVERY profile precisely because a missing row and a " +
        "scored row are different downstream; `?? { score: 0 }` erased that.",
    );
  });

  it("an unreadable table is `unavailable` for every creator, including ones with a row", () => {
    assert.equal(resolveCreatorActivity(measuredZero, CREATOR, true).state, "unavailable");
    assert.equal(resolveCreatorActivity(measuredZero, OTHER, true).state, "unavailable");
  });

  it("an item with no creator at all is `unscored` — there is nobody to have a row", () => {
    assert.equal(resolveCreatorActivity(measuredZero, null, false).state, "unscored");
    assert.equal(resolveCreatorActivity(measuredZero, undefined, false).state, "unscored");
  });
});

// ─── C2: and the ranker's behaviour is unchanged today ───────────────────────

/** A fixed creation instant: `new Date()` per call would move freshness between
 *  two otherwise identical ranking passes and make the comparison below false. */
const CREATED_AT = "2026-09-06T12:00:00.000Z";

function makeInput(itemId: string, creatorId: string | null): RankingInput {
  return {
    itemId, itemType: "post", creatorId,
    createdAt: CREATED_AT,
    city: "lisbon", country: "PT", tags: ["food"], category: "food", languageCode: "en",
    hasMedia: true, completeness: 1, positiveReviewRate: null, flagCount: 0,
    saveCount: 0, shareCount: 0, commentCount: 0, impressionCount: 0, uniqueViewerCount: 0,
    lat: null, lng: null, distanceKm: null,
    isDeleted: false, isExpired: false, isSuspended: false, isModerated: false,
    isPrivate: false, isAgeRestricted: false, minAgeRequired: null,
    isGeoRestricted: false, geoRestrictionCountries: null,
    authorIsBlockedByViewer: false, authorBlocksViewer: false, authorIsMutedByViewer: false,
    viewerHasReportedItem: false, viewerHasHiddenItem: false, viewerHasHiddenCreator: false,
    repeatCount: null, expiresAt: null, accountAgeDays: 400,
    isUnfamiliarCategory: false, isFirstImpression: false,
  };
}

const VIEWER: RankingViewerContext = {
  viewerId: "cccccccc-0000-4000-8000-0000000000v1",
  travelStyles: [], preferredLanguages: ["en"], preferredCities: [],
  currentCity: null, currentCountry: null, lat: null, lng: null, viewerAge: 30,
  followedCreatorIds: new Set(), mutedCreatorIds: new Set(), blockedCreatorIds: new Set(),
  seenItemIds: new Set(), sessionId: null, lastActiveAt: null,
};

describe("C2 — the distinction is INERT today, and that is asserted, not assumed", () => {
  // The ranker is on owner HOLD (docs/discovery/ROADMAP.md) and
  // ACTIVITY_DISCOVERY_BOOST_ENABLED is false in production. This change adds a
  // contract, not a behaviour. If these two ever diverge, someone has decided
  // what an unscored creator is worth — which is a ranking decision that needs a
  // ruling, not a side effect of a type change.
  const ACTIVE = {
    ACTIVITY_DISCOVERY_BOOST_ENABLED: true,
    NEW_CONTRIBUTOR_BOOST_ENABLED: false,
    RETURNING_USER_BOOST_ENABLED: false,
    UNDEREXPOSED_CONTENT_BOOST_ENABLED: false,
    RANKING_EXPERIMENT_ENABLED: false,
  };
  const nowMs = Date.parse("2026-09-07T12:00:00.000Z");

  it("a creator measured at 0 and a creator with no row score identically", async () => {
    const [measured] = await rankItems(
      [makeInput("i1", CREATOR)], "compass", VIEWER, null,
      {
        activityScores: new Map([[CREATOR, { score: 0, spam_penalty: 0 }]]),
        fatiguedCreators: new Set(), flags: ACTIVE,
      },
      { nowMs },
    );
    const [unscored] = await rankItems(
      [makeInput("i1", CREATOR)], "compass", VIEWER, null,
      { activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE },
      { nowMs },
    );

    assert.equal(measured.components.activityBoost, 0);
    assert.equal(unscored.components.activityBoost, 0);
    assert.equal(measured.components.spamPenalty, 0);
    assert.equal(unscored.components.spamPenalty, 0);
    assert.equal(
      measured.finalScore, unscored.finalScore,
      "the three-state read changed a ranking outcome. It must not: the ranker is on " +
        "owner HOLD and enabling the activity boost is B3, a gated Sybil decision.",
    );
  });

  it("CONTROL: a creator measured ABOVE zero still gets a boost, so the lane is live", async () => {
    const [boosted] = await rankItems(
      [makeInput("i1", CREATOR)], "compass", VIEWER, null,
      {
        activityScores: new Map([[CREATOR, { score: 90, spam_penalty: 0 }]]),
        fatiguedCreators: new Set(), flags: ACTIVE,
      },
      { nowMs },
    );
    assert.ok(
      boosted.components.activityBoost > 0,
      "a measured high score produces no boost — the null-guard swallowed a real value",
    );
  });

  it("CONTROL: a measured spam_penalty is still applied", async () => {
    const [penalised] = await rankItems(
      [makeInput("i1", CREATOR)], "compass", VIEWER, null,
      {
        activityScores: new Map([[CREATOR, { score: 50, spam_penalty: 25 }]]),
        fatiguedCreators: new Set(), flags: ACTIVE,
      },
      { nowMs },
    );
    assert.ok(penalised.components.spamPenalty > 0);
  });
});

// ─── The formula still treats the multiplier as a veto ───────────────────────

describe("the safety multiplier remains a veto on the score, not a component of it", () => {
  it("multiplier 0 collapses a productive creator's score to zero", () => {
    const base: CreatorSignals = {
      contributions24h: 5, contributions7d: 20, contributions30d: 50, contributions90d: 90,
      activeDays90: 60,
      participationEvents: 40, participationDistinctUsers: 20,
      receivedPositiveActions: 100, receivedInteractionVolume: 200,
      maintenanceActions: 10,
      burstEpisodes: 0, duplicateContentCount: 0, followUnfollowCycles: 0,
      rapidSameTypeCount: 0, eventCreateDeleteCycles: 0,
      safetyMultiplier: 1.0,
    };

    const healthy = computeActivityScore(CREATOR, base);
    const vetoed  = computeActivityScore(CREATOR, { ...base, safetyMultiplier: 0.0 });

    assert.ok(healthy.score > 0, "positive control: the creator scores when not vetoed");
    assert.equal(vetoed.score, 0, "a zero multiplier must collapse the score entirely");
  });
});
