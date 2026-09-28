/**
 * discoveryDerivedProvenanceGolden — census-discovery §68 (lane P21), DC-17.
 *
 * WHAT THIS FILE PROVES
 * =====================
 * §68 changes PROVENANCE only: which model and feature versions a derived store
 * stamps on its output. The 2026-08-15 ranker hold (census-discovery §66.9 Q1)
 * forbids any change to a computed value, a score, a trend state or an order.
 * So this file holds every number those stores and the ranker compute over one
 * fixed corpus to a sha256 captured at `f34994de7`, the tree BEFORE §68's edits.
 *
 *   G1  computeLocalMomentum values         (the scalar portavaRank consumes)
 *   G2  computeTrendStates state + evidence (the `03` §9 stage and its rates)
 *   G3  portavaRank.rankCandidates          (order, score and every feature)
 *   G4  buildRankProvenance                 (Compass features, scores, reasons)
 *   G5  reason CODES for every mapped key   (`01` §11 codes; §68's A03 edit
 *                                            changes served TEXT, never a code)
 *
 * Each golden is the hash of a canonical JSON with PROVENANCE REMOVED, so a
 * provenance edit cannot move it and any value edit must. The corpus is built
 * from a fixed-seed generator: no clock, no randomness, no I/O.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryDerivedProvenanceGolden.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { computeLocalMomentum, type MomentumRow } from "../lib/discoveryLocalMomentum.js";
import { computeTrendStates } from "../lib/discoveryTrendState.js";
import { rankCandidates, type RankCandidate } from "../lib/portavaRank.js";
import { buildRankProvenance, candidateSourceMap } from "../lib/discoveryRankProvenance.js";
import { reasonCodeForSignal } from "../lib/discoveryReasonCodes.js";

const NOW  = Date.parse("2026-09-20T12:00:00Z");
const HOUR = 3_600_000;

/** mulberry32 — a fixed-seed generator, so the corpus is identical on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OUTCOMES = ["impression", "impression", "impression", "save", "tap", "join", "dismiss", "analytics", "rsvp"];

/** 1,200 rank_events rows over 40 places, spread over 35 days (some outside the window, some in the future). */
function corpus(): MomentumRow[] {
  const r = rng(20260920);
  const rows: MomentumRow[] = [];
  for (let i = 0; i < 1_200; i++) {
    const place = Math.floor(r() * 40);
    // Skew: low ids are served mostly recently, high ids mostly long ago, so
    // every trend state and a spread of momentum values occur.
    const recentBias = place < 14 ? 0.7 : place < 28 ? 0.25 : 0.05;
    const ageH = r() < recentBias ? r() * 60 : r() * 35 * 24 - 2;
    const servedAt = NOW - ageH * HOUR;
    const outcome = OUTCOMES[Math.floor(r() * OUTCOMES.length)]!;
    const convertedAfterH = r() * 30;
    rows.push({
      item_id: `place-${place}`,
      outcome,
      served_at: new Date(servedAt).toISOString(),
      outcome_at: outcome === "impression" || outcome === "analytics" ? null : new Date(servedAt + convertedAfterH * HOUR).toISOString(),
    });
  }
  return rows;
}

/** Canonical JSON: keys sorted at every depth, so the hash names the values, not an insertion order. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  }
  return v;
}
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(canon(v))).digest("hex");

// ── The goldens, captured at f34994de7 (before §68) ──────────────────────────
const GOLDEN = {
  momentum: "6872be0d14ba37f5f69e5301d25587db2ffab8f43a99381c11c8362be7e2309c",
  trend:    "263624dc2c5508ad106c0566fb9f057796448880fe5e7c4c6931eb8aca4d1670",
  rank:     "0728cdda1be3773bbca4b811c6558087b854e353c99b74a3689dcfd957fcd1cb",
  compass:  "f6bf434a94f2ac8f8453ab388f0657f51664adcd84d77e71c4a71e862dfe50fa",
  codes:    "c829154ad2e26b88b2f596bd69c2c5f61c165e6e2852c72f02613795e20ced90",
};

function momentumValues() {
  return computeLocalMomentum(corpus(), NOW).values;
}

function trendValues() {
  const out: Record<string, unknown> = {};
  for (const [id, reading] of Object.entries(computeTrendStates(corpus(), NOW))) {
    out[id] = { state: reading.state, evidence: reading.evidence };   // provenance deliberately excluded
  }
  return out;
}

function rankValues() {
  const candidates: RankCandidate[] = Array.from({ length: 40 }, (_, i) => ({
    id: `place-${i}`,
    kind: i % 5 === 0 ? "gem" : "place",
    city: "lisbon",
    category: ["cafe", "bar", "museum", "park"][i % 4]!,
    distanceKm: (i * 0.7) % 9,
    likeCount: (i * 13) % 50,
    tags: i % 3 === 0 ? ["rooftop"] : ["local"],
    createdAt: new Date(NOW - (i + 1) * 36 * HOUR).toISOString(),
  } as RankCandidate));
  const ranked = rankCandidates(candidates, {
    userId: "viewer-1",
    city: "lisbon",
    nowMs: NOW,
    interestTags: new Set(["rooftop"]),
    categoryAffinities: { cafe: 0.8, bar: 0.3 },
    localMomentum: momentumValues(),
  }, { exploration: false });
  return ranked.map((s) => ({ id: s.candidate.id, score: s.score, features: s.features }));
}

function compassValues() {
  const rows = [
    { item: { id: "node/1" }, finalScore: 0.91, compassMatch: 0.7, communityScore: 0.2,
      rankingFactors: [{ key: "distance", weight: 0.8 }, { key: "open_now", weight: 1 }, { key: "trust", weight: 0.4 }] },
    { item: { id: "db/2" }, finalScore: 0.55, rankingFactors: [{ key: "interest_match", weight: 0.6 }, { key: "seen", weight: -0.2 }] },
    { item: { id: "way/3" }, finalScore: 0.1, compassMatch: Number.NaN, rankingFactors: [] },
  ];
  const prov = buildRankProvenance(rows, candidateSourceMap(["db/2"], ["node/1"]), NOW);
  const out: Record<string, unknown> = {};
  for (const [id, p] of prov) out[id] = { features: p.features, scores: p.scores, reasons: p.reasons, candidateSource: p.candidateSource };
  return out;
}

const SIGNAL_KEYS = [
  "distance", "city_match", "cityMatch", "neighborhoodMatch", "open_now", "availability", "time_relevance",
  "city_season", "actionability", "availabilityFit", "capacityOpen", "trailAffinity", "localMomentum",
  "followedAuthor", "engagedAuthor", "interest_match", "history", "memory_preference", "interestTag",
  "categoryAffinity", "social_style", "circle_memory_preference", "socialProof", "mutualAuthor", "governorSlot",
  "governor_underexposed", "safety_fit", "trust", "verifiedBonus", "seenPenalty", "language_match", "recency", "",
];
function codeValues() {
  return SIGNAL_KEYS.map((k) => [k, reasonCodeForSignal(k)]);
}

describe("§68 DC-17 — provenance-only: every computed value is byte-identical to f34994de7", () => {
  it("G0. the corpus exercises the stores: momentum and every non-trivial trend state occur", () => {
    const m = momentumValues();
    assert.ok(Object.keys(m).length >= 5, `momentum fires for several places (${Object.keys(m).length})`);
    const states = new Set(Object.values(computeTrendStates(corpus(), NOW)).map((r) => r.state));
    for (const s of ["unknown", "emerging", "trending", "established"] as const) assert.ok(states.has(s), `state ${s} occurs (${[...states].join(",")})`);
  });
  it("G1. local momentum values", () => { assert.equal(sha(momentumValues()), GOLDEN.momentum); });
  it("G2. trend states and their evidence", () => { assert.equal(sha(trendValues()), GOLDEN.trend); });
  it("G3. portavaRank order, scores and feature vectors over that momentum", () => { assert.equal(sha(rankValues()), GOLDEN.rank); });
  it("G4. Compass rank provenance: features, scores, reasons, candidate source", () => { assert.equal(sha(compassValues()), GOLDEN.compass); });
  it("G5. reason codes for every mapped, guardrailed and unknown signal key", () => { assert.equal(sha(codeValues()), GOLDEN.codes); });
});
