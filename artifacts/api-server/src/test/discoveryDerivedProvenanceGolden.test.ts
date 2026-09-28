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

// ════════════════════════════════════════════════════════════════════════════
// census-discovery §75 (lane P33, DC-17): the golden extended over every value
// §75's hunks touch. Appended at the foot, imports included (ES imports are
// hoisted), so no line above that a census cites moves. Captured at
// `ed9ab3ca0`, the tree BEFORE §75's edits, with provenance removed:
//
//   G6  the trend API: the head read's run and rows, and every explanation
//   G7  PDE `rankForViewer`: order, scores and every feature, modifiers on
//   G8  Trail health: the nine metrics, the multiplier, and the served view
//   G9  Trail `trending`: the momentum, the unread mark and the items behind
//       the served boolean, under all four read outcomes (both succeed, only
//       the per-item read fails, only the Trail read fails, both fail) and
//       for the empty Trail
// ════════════════════════════════════════════════════════════════════════════
import { explainExposures, readTrendSnapshot, TREND_DISCLOSURE_MIN_TRAVELERS as K } from "../lib/discoveryTrendExplanation.js";
import { rankForViewer, type PdePlace } from "../lib/discoveryPde.js";
import { inertModifiers } from "../lib/discoveryModifiers.js";
import { computeTrailHealth, trailHealthScale, type TrailMemberForHealth } from "../lib/discoveryTrailHealth.js";
import { trailTrending } from "../services/trails/TrailService.js";
import { _resetLocalMomentumCacheForTest } from "../lib/discoveryLocalMomentum.js";
import { makeFakeTrailsDb, type Row } from "./helpers/fakeTrailsDb.js";

/** §75's goldens, captured at ed9ab3ca0 (before its edits), provenance removed. */
const GOLDEN_P33 = {
  trendApi: "7aedb91a8557e7b51d51f1e64216050bfb09e8df6d8f14dd1d899ac7a4b6aa49",
  pde:      "c007ea42fc88ac4da38dc297a70240c44a0a285380cc8e8aae3c465b0841bccb",
  health:   "8c7a2b95e03313bfec60e09d9ecaa970c211a3b265708f9495d3da91a1da0151",
  trending: "972e6ebd12ccf7f2df10cbb5ddd2bf37e66256849b3d119f43c9068c97da6c67",
};

// ── §75 (lane P33) ───────────────────────────────────────────────────────────

/** A fake PostgREST over `place_momentum` for the trend API's two reads. */
function trendDb(rows: Row[]) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let desc = false; let limitN: number | null = null;
      interface B extends PromiseLike<{ data: Row[]; error: null }> {
        select(): B; eq(c: string, v: unknown): B; in(c: string, v: unknown[]): B;
        order(c: string, o?: { ascending?: boolean }): B; limit(n: number): B;
      }
      const b: B = {
        select() { return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return b; },
        order(_c: string, o?: { ascending?: boolean }) { desc = o?.ascending === false; return b; },
        limit(n: number) { limitN = n; return b; },
        then(res, rej) {
          if (table !== "place_momentum") throw new Error(`trendDb: ${table}`);
          let out = rows.filter((r) => filters.every((f) => f(r)));
          out = [...out].sort((a, z) => (String(a["computed_at"]) < String(z["computed_at"]) ? -1 : 1) * (desc ? -1 : 1));
          if (limitN !== null) out = out.slice(0, limitN);
          return Promise.resolve({ data: out.map((r) => ({ ...r })), error: null as null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

async function trendApiValues() {
  const at = new Date(NOW - 60_000).toISOString();
  const older = new Date(NOW - 2 * HOUR).toISOString();
  const states = ["trending", "emerging", "established", "unknown", "cooling", "rediscovered", "bogus"];
  const pm: Row[] = [];
  for (let i = 0; i < 14; i++) {
    pm.push({
      place_id: `place-${i}`, computed_at: at, trend_state: states[i % states.length],
      recent_unique_travelers: i % 4 === 0 ? null : K - 1 + (i % 3), window_unique_travelers: K + (i % 2),
      model_version: "discovery-trend-state-v1", feature_version: "discovery-weighted-activity-v2",
      window_ms: { recent_ms: 172_800_000, mid_ms: 604_800_000, prior_ms: 2_592_000_000 }, source_surface: "discovery",
    });
  }
  pm.push({ ...pm[0]!, computed_at: older, trend_state: "cooling" });
  const ids = Array.from({ length: 16 }, (_, i) => `place-${i}`);
  const read = await readTrendSnapshot(trendDb(pm), ids);
  assert.equal(read.ok, true, "the head read succeeded");
  if (!read.ok || !read.run) throw new Error("no run");
  const run = { computedAt: read.run.computedAt, modelVersion: read.run.modelVersion, priorMs: read.run.priorMs };  // featureVersion deliberately excluded
  const rids = ids.map((id, i) => `rid-${String(i).padStart(2, "0")}`.padEnd(22, "x"));
  const bindings = ids.slice(0, 15).map((itemId, i) => ({ recommendationId: rids[i]!, itemId }));
  const explained = explainExposures(rids, bindings, read.run, read.rows, NOW);
  const stale = explainExposures(rids, bindings, { ...read.run, computedAt: older }, read.rows, NOW);
  // Either side of the freshness bound (TREND_SNAPSHOT_MAX_AGE_MS = 10 min), so moving it is caught.
  const edge = (msAgo: number) => explainExposures(rids, bindings, { ...read.run!, computedAt: new Date(NOW - msAgo).toISOString() }, read.rows, NOW).explanations;
  return { run, rows: read.rows, explanations: explained.explanations, stale: stale.explanations, justFresh: edge(9 * 60_000), justStale: edge(11 * 60_000) };  // readingProvenance deliberately excluded
}

async function pdeValues() {
  const places: PdePlace[] = Array.from({ length: 24 }, (_, i) => ({
    id: i % 4 === 0 ? `db/place-${i}` : `node/${i}`,
    category: ["cafe", "bar", "museum", "park"][i % 4]!,
    distanceKm: (i * 0.9) % 7,
    savedCount: (i * 7) % 30,
    tags: i % 3 === 0 ? ["rooftop"] : ["local"],
    rating: 3 + (i % 3),
  }));
  const localMomentum: Record<string, number> = {};
  for (const [k, v] of Object.entries(momentumValues())) {
    const n = Number(k.slice("place-".length));
    if (n < 24) localMomentum[n % 4 === 0 ? `db/place-${n}` : `node/${n}`] = v;
  }
  const modifiers = { ...inertModifiers("flag_off"), enabled: true, reason: "flag_on" as const, localMomentum, momentumScale: 1, explorationBudgetPct: 20 };
  const outcome = await rankForViewer(places, {
    userId: "viewer-1", city: "lisbon", followedIds: new Set(), interestTags: new Set(["rooftop"]),
    categoryAffinities: { cafe: 0.8, bar: 0.3 },
  }, { sc: null, served: false, modifiers, nowMs: NOW, candidateKey: "golden:pde" });
  return {
    order: outcome.ranked.map((p) => p.id),
    scored: [...outcome.scoredById.entries()].map(([id, s]) => ({ id, score: s.score, features: s.features })),
    stages: { portavaRank: outcome.stages.portavaRank, modifiers: outcome.stages.modifiers, governor: outcome.stages.governor },
  };
}

function healthValues() {
  const r = rng(7501);
  const out: unknown[] = [];
  for (let t = 0; t < 12; t++) {
    const n = t === 0 ? 0 : 1 + Math.floor(r() * 14);
    const members: TrailMemberForHealth[] = Array.from({ length: n }, () => ({
      source_id: `s-${Math.floor(r() * 6)}`,
      contributor_id: r() < 0.15 ? null : `u-${Math.floor(r() * 4)}`,
      confidence: Math.round(r() * 100) / 100,
      content_state: r() < 0.1 ? "archived_from_active_rotation" : "just_arrived",
      created_at: new Date(NOW - r() * 120 * 24 * HOUR).toISOString(),
    }));
    const h = computeTrailHealth({ members, reportCount: t % 3 === 0 ? null : t, nowMs: NOW });
    out.push({ metrics: h.metrics, unmeasured: h.unmeasured, modelVersion: h.modelVersion, freshTodayShare: h.freshTodayShare, memberCount: h.memberCount, scale: trailHealthScale(h) });
  }
  return out;
}

const T_G = "22222222-2222-4222-8222-2222222222a1";
const P_G = ["33333333-3333-4333-8333-3333333333a1", "33333333-3333-4333-8333-3333333333b1", "33333333-3333-4333-8333-3333333333c1"];

async function trendingValues() {
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const seed = (): Record<string, Row[]> => ({
    trails: [{ id: T_G, slug: "slug-g", title: "Trail G", description: null, destination: "bangkok", place_scope: null,
      parent_trail_id: null, lifecycle_status: "active", created_by: "11111111-1111-4111-8111-111111111111",
      created_at: iso(86_400_000), updated_at: iso(86_400_000) }],
    content_trails: P_G.map((p, i) => ({ id: `m${i}`, trail_id: T_G, source_type: "place", source_id: p, relationship: "primary",
      signal: null, source: "user", confidence: 0.9, contributor_id: `u-${i}`, content_state: "just_arrived", created_at: iso(3_600_000 * (i + 1)) })),
    rank_events: [
      ...Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, item_id: P_G[0], surface: "discovery", outcome: "save", served_at: iso(3_600_000 + i), outcome_at: iso(3_600_000 + i) })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, item_id: P_G[1], surface: "trips", outcome: "tap", served_at: iso(7_200_000 + i), outcome_at: iso(7_200_000 + i) })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, item_id: P_G[2], surface: "discovery", outcome: "impression", served_at: iso(20 * 86_400_000 + i), outcome_at: null })),
    ],
  });
  const out: Record<string, unknown> = {};
  const cases: Array<[string, Parameters<typeof makeFakeTrailsDb>[1], boolean]> = [
    ["both", {}, false], ["itemFails", { failRankEvents: "discovery" }, false],
    ["trailFails", { failRankEvents: "all_surfaces" }, false], ["bothFail", { erroring: ["rank_events"] }, false],
    ["empty", {}, true],
  ];
  for (const [name, opts, empty] of cases) {
    _resetLocalMomentumCacheForTest();
    const s = seed();
    if (empty) s["content_trails"] = [];
    const r = await trailTrending(makeFakeTrailsDb(s, opts), T_G, NOW);
    out[name] = { refusal: r.refusal, momentum: r.momentum, momentumUnread: r.momentumUnread ?? null, items: r.items };  // momentumProvenance deliberately excluded
  }
  return out;
}

describe("§75 DC-17 (lane P33) — provenance-only: every value its hunks touch is byte-identical to ed9ab3ca0", () => {
  const show = process.env["P33_PRINT_GOLDEN"] === "1";
  it("G6. the trend API: the head read's run and rows, and every explanation (fresh and stale)", async () => {
    const v = await trendApiValues();
    const disclosed = v.explanations.filter((e) => e.trend !== null).map((e) => e.trend!.state);
    assert.ok(new Set(disclosed).size >= 3, `precondition: several states are disclosed (${disclosed.join(",")})`);
    assert.ok(v.explanations.some((e) => e.unavailable === "insufficient_evidence"), "precondition: the floor withholds some");
    const h = sha(v); if (show) console.log("trendApi", h); assert.equal(h, GOLDEN_P33.trendApi);
  });
  it("G7. PDE rankForViewer: order, scores and every feature, modifiers on", async () => {
    const v = await pdeValues();
    assert.ok(v.scored.some((s) => (s.features["localMomentum"] ?? 0) > 0), "precondition: momentum reached the ranker");
    const h = sha(v); if (show) console.log("pde", h); assert.equal(h, GOLDEN_P33.pde);
  });
  it("G8. Trail health: the nine metrics, the unmeasured list and the multiplier", () => {
    const h = sha(healthValues()); if (show) console.log("health", h); assert.equal(h, GOLDEN_P33.health);
  });
  it("G9. Trail trending: momentum, the unread mark and items, under all four read outcomes and the empty Trail", async () => {
    const v = await trendingValues() as Record<string, { momentum: number | null; momentumUnread: boolean | null }>;
    assert.ok((v["both"]!.momentum ?? 0) > 0, "precondition: the Trail is trending when both reads succeed");
    assert.equal(v["itemFails"]!.momentum, v["both"]!.momentum, "precondition: the item-read failure leaves the Trail's measured boolean");
    assert.equal(v["trailFails"]!.momentumUnread, true, "precondition: the Trail-read failure is unread");
    const h = sha(v); if (show) console.log("trending", h); assert.equal(h, GOLDEN_P33.trending);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// census-discovery §84 (lane W10-R1): the v2 trend model is behind
// `discovery_trend_normalised_enabled` (3475, seeded FALSE). With it OFF — absent,
// FALSE or unreadable — every NEW entry point must return the values captured at
// `f34994de7` (GOLDEN above), byte for byte:
//
//   G10  computeTrendStates / computeLocalMomentum with an options argument
//        that does not ask for v2 ({} and { model: "v1" })
//   G11  loadLocalMomentum through a client whose flag row is absent, FALSE or
//        unreadable, and the trend states it caches for readLocalTrendStates
//   G12  the trend API (G6's corpus) through explainExposures with a Local Pulse
//        argument: a v1 run ignores it
// ════════════════════════════════════════════════════════════════════════════
import { loadLocalMomentum, readLocalTrendStates } from "../lib/discoveryLocalMomentum.js";

/** A client serving the corpus through the loader's paged read, with the v2 flag row as given. */
function corpusClient(flag: "absent" | "false" | "error") {
  const rows = corpus();
  return {
    from(table: string) {
      let range: [number, number] = [0, rows.length - 1];
      const b: any = {
        select() { return b; }, eq() { return b; }, neq() { return b; }, in() { return b; }, gte() { return b; }, order() { return b; },
        range(a: number, z: number) { range = [a, z]; return b; },
        maybeSingle() {
          if (table !== "feature_flags") throw new Error(`corpusClient: ${table}.maybeSingle`);
          if (flag === "error") return Promise.resolve({ data: null, error: { code: "57014", message: "timeout" } });
          return Promise.resolve({ data: flag === "false" ? { enabled: false } : null, error: null });
        },
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
          if (table !== "rank_events") throw new Error(`corpusClient: ${table}`);
          return Promise.resolve({ data: rows.filter((r) => r.outcome !== "analytics").slice(range[0], range[1] + 1), error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}
const stripTrend = (m: Record<string, { state: unknown; evidence: unknown }>) =>
  Object.fromEntries(Object.entries(m).map(([id, r]) => [id, { state: r.state, evidence: r.evidence }]));

describe("§84 (lane W10-R1) — the v2 trend model OFF: every new entry point is byte-identical to f34994de7", () => {
  it("G10. an options argument that does not ask for v2 changes nothing", () => {
    for (const opts of [{}, { model: "v1" as const }]) {
      assert.equal(sha(computeLocalMomentum(corpus(), NOW, opts).values), GOLDEN.momentum, JSON.stringify(opts));
      assert.equal(sha(stripTrend(computeTrendStates(corpus(), NOW, opts))), GOLDEN.trend, JSON.stringify(opts));
    }
  });

  it("G11. the loader with the flag absent, FALSE or unreadable: the momentum and the cached trend states", async () => {
    for (const flag of ["absent", "false", "error"] as const) {
      _resetLocalMomentumCacheForTest();
      const m = await loadLocalMomentum(corpusClient(flag), Array.from({ length: 40 }, (_, i) => `place-${i}`), { cacheKey: `g11:${flag}`, nowMs: NOW });
      // The loader never reads analytics rows (it filters them in the query), and the kernel ignores them: same values.
      assert.equal(sha(m.values), GOLDEN.momentum, flag);
      assert.equal(sha(stripTrend(readLocalTrendStates(`g11:${flag}`, NOW))), GOLDEN.trend, flag);
    }
  });

  it("G12. the trend API over a v1 run ignores a Local Pulse argument", async () => {
    const v = await trendApiValues();
    const read = await readTrendSnapshot(trendDb([]), []);
    assert.ok(read.ok);
    const rids = ["rid-00".padEnd(22, "x")];
    const run = { computedAt: new Date(NOW - 60_000).toISOString(), modelVersion: "discovery-trend-state-v1", featureVersion: null, priorMs: 2_592_000_000 };
    const rows = [{ place_id: "place-1", trend_state: "trending", recent_unique_travelers: K, window_unique_travelers: K, cell_key: "n:x:y" }];
    const areas = [{ cell_key: "n:x:y", cell_label: "Y", trend_state: "trending", driver: "saves", recent_unique_travelers: K, window_unique_travelers: K }];
    const binding = [{ recommendationId: rids[0]!, itemId: "place-1" }];
    assert.equal(JSON.stringify(explainExposures(rids, binding, run, rows, NOW, areas)), JSON.stringify(explainExposures(rids, binding, run, rows, NOW)));
    assert.equal(sha(v), GOLDEN_P33.trendApi, "G6's corpus, unchanged");
  });
});
