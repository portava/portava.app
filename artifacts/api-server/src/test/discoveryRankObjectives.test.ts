/**
 * census-discovery §78 (lane W10-R2) — DC-13 (`06` §3's eleven feature
 * families) and DV-09 (`01` §9's five surface objectives). Controlled data;
 * no claim about real-world effectiveness.
 *
 *   F1  every feature key portavaRank can write belongs to exactly one family
 *   F2  every one of the eleven families has at least one scored term
 *   F3  trail_relevance and negative_feedback terms are scored by portavaRank
 *   F4  familyBreakdown sums back to the score (no feature lost)
 *   F5  the all-ones objective is the identity, bit for bit
 *   O1  the five surfaces order ONE candidate set five different ways, each
 *       exactly as its family multipliers predict by hand
 *   O2  the owner caps hold under every objective (momentum, Trail)
 *   O3  Trail: freshness appropriate to content type (per-kind weights)
 *   O4  Trail: contributor and place diversity arrive with the objective; a
 *       caller's own diversity keys win
 *   O5  metadata overrides: parsed, bounded, and never guessed
 *   S1  source guard: no Discovery lib or route imports rankingConfig
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/discoveryRankObjectives.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  FEATURE_FAMILIES, FEATURE_FAMILY, featuresOfFamily, familyBreakdown,
  SURFACE_OBJECTIVES, RANK_SURFACES, objectiveForSurface, parseObjectiveOverrides, OBJECTIVE_MULTIPLIER_MAX,
} from "../lib/discoveryRankObjectives.js";
import {
  rankCandidates, scoreCandidate, rescoreForObjective, DEFAULT_WEIGHTS,
  LOCAL_MOMENTUM_MAX_CONTRIBUTION, type RankCandidate, type ViewerContext,
} from "../lib/portavaRank.js";
import { TRAIL_AFFINITY_MAX_CONTRIBUTION } from "../lib/discoveryTrailAffinity.js";
import { goldenCandidates, goldenViewers, GOLDEN_NOW_MS } from "./helpers/portavaRankGoldenScenarios.js";

const NOW = GOLDEN_NOW_MS;
const H = 3_600_000;

/** A viewer and candidate set where every design input is present, so every key is written. */
function everyKeyViewer(): ViewerContext {
  return {
    ...goldenViewers().full,
    intent: { source: "request", modes: [{ mode: "nearby", weights: { travel: 1 }, keywords: [] }], categoryHints: [] },
    tripMatch: { "node/1001": 1 },
    negativeFeedback: { categoryDismissals: { food: 2 } },
    explorationValue: true,
  };
}

describe("F — `06` §3: eleven families, each with its term", () => {
  it("F1 every key portavaRank writes has exactly one family", () => {
    const keys = new Set<string>();
    for (const c of goldenCandidates()) for (const k of Object.keys(scoreCandidate(c, everyKeyViewer(), DEFAULT_WEIGHTS, true).features)) keys.add(k);
    // officialPublisher / placeEngagement only appear when their boost fires; the fixture fires both.
    for (const k of keys) assert.ok(FEATURE_FAMILY[k], `feature ${k} has no family`);
    for (const k of Object.keys(FEATURE_FAMILY)) assert.ok(keys.has(k), `family map names ${k}, which portavaRank never writes`);
  });

  it("F2 every one of the eleven families has at least one term, in the spec's order", () => {
    assert.deepEqual([...FEATURE_FAMILIES], [
      "relevance", "travel_intent", "freshness", "quality", "trust", "novelty",
      "social_relevance", "place_relevance", "trail_relevance", "exploration_value", "negative_feedback",
    ]);
    for (const f of FEATURE_FAMILIES) assert.ok(featuresOfFamily(f).length > 0, `${f} has no term`);
  });

  it("F3 trail_relevance and negative_feedback are scored terms, not names", () => {
    const ctx = everyKeyViewer();
    const food: RankCandidate = { id: "x-food", kind: "place", category: "food", createdAt: new Date(NOW - H).toISOString() };
    const bar: RankCandidate = { id: "node/1007", kind: "place", category: "nightlife", createdAt: new Date(NOW - H).toISOString() };
    const sf = scoreCandidate(food, ctx).features;
    assert.ok(sf.negativeFeedback < 0, "two dismissals in `food` penalise another food place");
    const sb = scoreCandidate(bar, ctx).features;
    assert.equal(sb.negativeFeedback, 0, "no dismissal in `nightlife`, no penalty");
    assert.ok(sb.trailAffinity > 0, "trail_relevance scores the followed-Trail modifier");
    assert.deepEqual(featuresOfFamily("trail_relevance"), ["trailAffinity"]);
    assert.deepEqual(featuresOfFamily("negative_feedback"), ["negativeFeedback"]);
  });

  it("F4 the family view loses nothing: families sum to the score", () => {
    for (const c of goldenCandidates()) {
      const s = scoreCandidate(c, everyKeyViewer(), DEFAULT_WEIGHTS, true);
      const b = familyBreakdown(s.features);
      const sum = Object.values(b).reduce((a, v) => a + v, 0);
      assert.ok(Math.abs(sum - s.score) < 1e-9, `${c.id}: ${sum} vs ${s.score}`);
      assert.equal(b.unfamilied, 0);
    }
  });

  it("F5 an objective whose every multiplier is 1 changes no bit", () => {
    const ctx = everyKeyViewer();
    const a = rankCandidates(goldenCandidates(), ctx, {});
    const ones = { surface: "ones", featureWeights: Object.fromEntries(Object.keys(FEATURE_FAMILY).map((k) => [k, 1])) };
    const b = rankCandidates(goldenCandidates(), ctx, { objective: ones });
    assert.equal(JSON.stringify(b.map((s) => [s.candidate.id, s.score, s.features])), JSON.stringify(a.map((s) => [s.candidate.id, s.score, s.features])));
    const scored = goldenCandidates().map((c) => scoreCandidate(c, ctx));
    assert.equal(rescoreForObjective(scored, {}), scored, "no objective ⇒ the same array");
  });
});

/**
 * Five candidates, each carrying ONE family's term on top of an identical,
 * negligible recency base (all are `place`, no city, no distance), sized so the
 * unweighted scores sit within 0.09 of each other:
 *
 *   fresh  recency +0.259 (freshness)      taste  interestTag 0.3 (relevance)
 *   trip   tripMatch 0.27 (travel_intent)  trend  trust 0.273 (trust)
 *   trail  trailAffinity 0.06 + verified 0.15 (trail_relevance + quality)
 *
 * Worked by hand in census-discovery §78.6: every expected position below is
 * the arithmetic of the family multipliers, not an observed output.
 */
function surfaceFixture(): { ctx: ViewerContext; cands: RankCandidate[] } {
  const ctx: ViewerContext = {
    userId: "v", nowMs: NOW, interestTags: new Set(["rooftop"]),
    trailAffinity: { trail: 0.6 }, tripMatch: { trip: 0.9 },
  };
  const old = new Date(NOW - 360 * H).toISOString();
  return {
    ctx,
    cands: [
      { id: "fresh", kind: "place", createdAt: new Date(NOW - 70 * H).toISOString() },
      { id: "taste", kind: "place", createdAt: old, tags: ["rooftop"] },
      { id: "trail", kind: "place", createdAt: old, verified: true },
      { id: "trip", kind: "place", createdAt: old },
      { id: "trend", kind: "place", createdAt: old, authorTrustScore: 91 },
    ],
  };
}

describe("O — `01` §9: five surfaces, each ranked by its own weights", () => {
  it("O1 one candidate set, five orders, each the hand-worked arithmetic of its own family weights", () => {
    const { ctx, cands } = surfaceFixture();
    const order = (s: (typeof RANK_SURFACES)[number]) =>
      rankCandidates(cands.map((c) => ({ ...c })), ctx, { objective: objectiveForSurface(s), exploration: false, diversity: false }).map((x) => x.candidate.id);
    const orders = Object.fromEntries(RANK_SURFACES.map((s) => [s, order(s)]));
    const unweighted = rankCandidates(cands.map((c) => ({ ...c })), ctx, { exploration: false, diversity: false }).map((x) => x.candidate.id);
    assert.equal(new Set(Object.values(orders).map((o) => o.join())).size, 5, `five distinct orders: ${JSON.stringify(orders)}`);
    for (const s of RANK_SURFACES) assert.notDeepEqual(orders[s], unweighted, `${s} must not be the universal order`);
    assert.deepEqual(unweighted, ["taste", "trend", "trip", "fresh", "trail"]);
    assert.deepEqual(orders.pulse, ["fresh", "trip", "taste", "trend", "trail"], "Pulse: freshness, then live context");
    assert.deepEqual(orders.discovery, ["taste", "trip", "trend", "fresh", "trail"], "Discovery: personalised relevance and travel intent");
    assert.deepEqual(orders.trail, ["trend", "taste", "trail", "trip", "fresh"], "Trail: confidence, and Trail relevance rises");
    assert.deepEqual(orders.trip_planning, ["trip", "taste", "trend", "trail", "fresh"], "Trip Planning: trip fit");
    assert.deepEqual(orders.trending, ["trend", "fresh", "taste", "trip", "trail"], "Trending: anti-manipulation (trust) and freshness");
    const pos = (s: (typeof RANK_SURFACES)[number]) => orders[s].indexOf("trail");
    for (const s of RANK_SURFACES) if (s !== "trail") assert.ok(pos("trail") < pos(s), `the Trail member ranks best on the Trail surface (vs ${s})`);
  });

  it("O2 the owner-ruled caps hold under every objective", () => {
    const ctx: ViewerContext = { userId: "v", nowMs: NOW, localMomentum: { m: 1 }, trailAffinity: { m: 1 } };
    for (const s of RANK_SURFACES) {
      const [r] = rankCandidates([{ id: "m", kind: "place" }], ctx, { objective: objectiveForSurface(s, { place_relevance: 3, trail_relevance: 3 }) });
      assert.ok(r.features.localMomentum <= LOCAL_MOMENTUM_MAX_CONTRIBUTION + 1e-12, `${s} lifted momentum to ${r.features.localMomentum}`);
      assert.ok(r.features.trailAffinity <= TRAIL_AFFINITY_MAX_CONTRIBUTION + 1e-12, `${s} lifted Trail to ${r.features.trailAffinity}`);
    }
  });

  it("O3 Trail weighs freshness by content type: an event's recency up, a place's down", () => {
    const o = objectiveForSurface("trail");
    assert.equal(o.kindFeatureWeights?.event?.recency, 1.5);
    assert.equal(o.kindFeatureWeights?.place?.recency, 0.75);
    assert.equal(o.kindFeatureWeights?.event?.trailAffinity, 1.5, "per-kind weights keep the surface's other families");
    const ctx: ViewerContext = { userId: "v", nowMs: NOW };
    const created = new Date(NOW - H).toISOString();
    const [ev] = rankCandidates([{ id: "e", kind: "event", createdAt: created }], ctx, { objective: o });
    const [pl] = rankCandidates([{ id: "p", kind: "place", createdAt: created }], ctx, { objective: o });
    assert.ok(ev.features.recency > pl.features.recency);
  });

  it("O4 Trail's contributor and place diversity arrive with the objective; the caller's own keys win", () => {
    const o = objectiveForSurface("trail");
    assert.deepEqual(o.diversity, { authorPenalty: 0.35 * 1.5, placePenalty: 0.35 });
    const ctx: ViewerContext = { userId: "v", nowMs: NOW };
    const cands: RankCandidate[] = [
      { id: "a1", kind: "place", authorId: "A", createdAt: new Date(NOW - H).toISOString() },
      { id: "a2", kind: "place", authorId: "A", createdAt: new Date(NOW - 1.1 * H).toISOString() },
      { id: "b1", kind: "place", authorId: "B", createdAt: new Date(NOW - 30 * H).toISOString() },
    ];
    const plain = rankCandidates(cands.map((c) => ({ ...c })), ctx, { exploration: false }).map((x) => x.candidate.id);
    // The objective's DIVERSITY alone — no feature or per-kind weights — so the move is the penalty's.
    const diversityOnly = { surface: "trail", featureWeights: {}, diversity: o.diversity };
    const trail = rankCandidates(cands.map((c) => ({ ...c })), ctx, { exploration: false, objective: diversityOnly }).map((x) => x.candidate.id);
    assert.deepEqual(plain, ["a1", "a2", "b1"]);
    assert.deepEqual(trail, ["a1", "b1", "a2"], "the stronger contributor penalty separates the two A picks");
    const callerWins = rankCandidates(cands.map((c) => ({ ...c })), ctx, { exploration: false, diversity: { authorPenalty: 0.35 }, objective: diversityOnly }).map((x) => x.candidate.id);
    assert.deepEqual(callerWins, ["a1", "a2", "b1"]);
  });

  it("O5 overrides from the flag metadata are bounded and never guessed", () => {
    const parsed = parseObjectiveOverrides({ surfaces: {
      discovery: { novelty: 2, relevance: 99, bogus: 1, trust: -1 },
      pulse: null, trail: "x", trending: { freshness: OBJECTIVE_MULTIPLIER_MAX },
    } });
    assert.deepEqual(parsed, { discovery: { novelty: 2 }, trending: { freshness: 3 } });
    assert.deepEqual(parseObjectiveOverrides(null), {});
    assert.deepEqual(parseObjectiveOverrides({ surfaces: { discovery: null } }), {});
    const o = objectiveForSurface("discovery", parsed.discovery);
    assert.equal(o.featureWeights.seenPenalty, 2, "novelty override reaches its key");
    assert.equal(o.featureWeights.interestTag, 1.25, "an unset family keeps the code default");
    for (const s of RANK_SURFACES) assert.equal(SURFACE_OBJECTIVES[s].surface, s);
  });
});

describe("S — §41.4 hazard: the families are a view, not a fourth consumer of rankingConfig", () => {
  it("S1 no lib/discovery*.ts or routes/discovery*.ts imports services/ranking/rankingConfig", () => {
    const hits: string[] = [];
    for (const [dir, rel] of [["../lib", "lib"], ["../routes", "routes"]] as const) {
      for (const f of readdirSync(new URL(dir, import.meta.url))) {
        if (!/^discovery.*\.ts$/.test(f)) continue;
        const src = readFileSync(new URL(`${dir}/${f}`, import.meta.url), "utf8");
        if (/from\s+["'][^"']*rankingConfig(\.js)?["']/.test(src)) hits.push(`${rel}/${f}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});
