/**
 * discoveryCandidatePipelineGolden — census-discovery §85 (lane W10-R3).
 *
 * WHAT THIS FILE PROVES
 * =====================
 * §85 adds candidate generation, an explicit exploration inventory, cold start,
 * an outcome-learning stage and an integrity-stage hook to `rankForViewer`, each
 * behind a NEW flag seeded FALSE (migrations 3480–3483). The lane rule is that
 * with every one of those flags OFF the PDE output is BYTE-IDENTICAL to the tree
 * before §85. This file holds that output to sha256 hashes captured at
 * `6d1e7090b` — the branch point, before any §85 edit — over three runs:
 *
 *   P1  modifiers OFF, no client          (the `no_client` path)
 *   P2  modifiers OFF, a fake client       (the served path as production runs
 *                                           it today: 2289 FALSE, DRS reading)
 *   P3  modifiers ON (injected)            (the governor path, as §75's G7)
 *
 * Each hash covers the served order, every scored row's score and feature
 * vector, the whole `stages` object and the governor outcome — everything
 * `rankForViewer` returns except wall-clock timings. P4 pins the reads: with
 * the §85 flags off, the ONLY new read is one `feature_flags` row read.
 *
 * The clock is mocked, because portavaRank's epsilon slot is seeded per
 * (viewer, hour) from `Date.now()` when the modifiers are off.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryCandidatePipelineGolden.test.ts
 */
import { describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rankForViewer, type PdePlace, type PdeViewer } from "../lib/discoveryPde.js";
import { inertModifiers, invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import { makeFakeCandidateDb, type Row } from "./helpers/fakeCandidateDb.js";

const NOW = Date.parse("2026-09-28T09:30:00Z");

/** Captured at 6d1e7090b with the code unchanged (P85_PRINT_GOLDEN=1 prints them). */
const GOLDEN_W10_R3 = {
  p1: "e7486e8dab8589213ce34e0190432ea0e5dc96d763a3eca19dfaec2a0992123f",
  p2: "6e13c50aac3546021018a48f52757f642f9d0298cf0fc6e59ca9f5bd8f5ea203",
  p3: "2c948ae6a91d432afc85b9455136118d4922eeb7b72eae1a9a77711444b23b05",
  /** The table sequence P2 read at 6d1e7090b. */
  p2Reads: "ffb91fd80481bfaf4fc9b2ea60f4bb765f97d56cdc9c6cdd0a893a18df95f82d",
};

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function goldenPlaces(): PdePlace[] {
  return Array.from({ length: 30 }, (_, i) => ({
    id: i % 3 === 0 ? `db/${uuid(i)}` : `node/${1000 + i}`,
    category: ["food", "nightlife", "culture", "beaches", "shopping"][i % 5]!,
    distanceKm: Math.round(((i * 1.3) % 9) * 10) / 10,
    savedCount: (i * 11) % 40,
    tags: i % 4 === 0 ? ["rooftop", "food"] : ["local"],
    rating: 3 + (i % 3) * 0.5,
    lat: 25.7 + i / 1000, lng: -80.2 - i / 1000,
    headerImageUrl: i % 2 === 0 ? `https://img.example/${i}.jpg` : null,
    description: i % 5 === 0 ? `about ${i}` : null,
    neighborhood: i % 6 === 0 ? "Wynwood" : null,
  }));
}

export function goldenViewer(): PdeViewer {
  return {
    userId: "11111111-1111-4111-8111-111111111111", city: "miami",
    followedIds: new Set(["22222222-2222-4222-8222-222222222222"]),
    interestTags: new Set(["rooftop"]),
    categoryAffinities: { food: 1, nightlife: 0.4 },
    seenIds: new Set([`node/1001`, `db/${uuid(9)}`]),
    placeAffinities: { [`db/${uuid(3)}`]: 3 },
    degraded: [], neighborhood: "Wynwood",
  };
}

/** The tables P2's fake answers: the PDE path's own reads, no §85 flag row. */
export function goldenTables(): Record<string, Row[]> {
  return {
    feature_flags: [{ flag: "discovery_ranking_modifiers_enabled", enabled: false }],
    rank_events: [], user_activity_scores: [], content_distribution_stats: [],
  };
}

function canon(v: unknown): unknown {
  if (v instanceof Set) return [...v].sort();
  if (v instanceof Map) return [...v.entries()].map(([k, x]) => [k, canon(x)]);
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  }
  return v;
}
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(canon(v))).digest("hex");

/** The keys §85 may add to `stages` and to the outcome: with every §85 flag off none may be PRESENT (not even `undefined`). */
export const P85_STAGE_KEYS = ["candidateGeneration", "coldStart", "explorationInventory", "integrity", "outcomeLearning"] as const;

export async function outcomeValues(o: Awaited<ReturnType<typeof rankForViewer>>) {
  for (const k of P85_STAGE_KEYS) assert.ok(!(k in o.stages), `stages.${k} is absent, not undefined`);
  assert.ok(!("candidateSources" in o), "outcome.candidateSources is absent");
  if (o.stages.graphReading) assert.ok(!("provenance" in o.stages.graphReading), "graphReading.provenance is absent");
  return {
    order: o.ranked.map((p) => p.id),
    scored: [...o.scoredById.entries()].map(([id, s]) => ({ id, score: s.score, features: s.features })),
    stages: o.stages,
    governor: o.governor,
    modifiersReason: o.modifiers.reason,
  };
}

describe("§85 (lane W10-R3) — with every §85 flag OFF, rankForViewer is byte-identical to 6d1e7090b", () => {
  const show = process.env["P85_PRINT_GOLDEN"] === "1";
  before(() => { mock.timers.enable({ apis: ["Date"], now: NOW }); });
  after(() => { mock.timers.reset(); });

  it("P1. modifiers off, no client", async () => {
    invalidateDiscoveryModifiersFlagCache();
    const o = await rankForViewer(goldenPlaces(), goldenViewer(), { sc: null, served: true, nowMs: NOW });
    assert.equal(o.stages.modifiers, "no_client");
    const h = sha(await outcomeValues(o)); if (show) console.log("p1", h);
    assert.equal(h, GOLDEN_W10_R3.p1);
  });

  it("P2. modifiers off, a fake client (the production served path today)", async () => {
    invalidateDiscoveryModifiersFlagCache();
    const db = makeFakeCandidateDb(goldenTables());
    const o = await rankForViewer(goldenPlaces(), goldenViewer(), { sc: db, served: false, nowMs: NOW });
    assert.equal(o.stages.modifiers, "flag_off");
    const h = sha(await outcomeValues(o)); if (show) console.log("p2", h);
    assert.equal(h, GOLDEN_W10_R3.p2);
    // P4 — the reads: at 6d1e7090b P2 read exactly this table sequence. §85
    // adds one `feature_flags` read (its own flags, fail-closed) and nothing else.
    const tables = db.reads.map((r) => r.table);
    const isOurs = (r: { table: string; ops: string[] }) => r.table === "feature_flags" && r.ops.some((o) => o.startsWith("in(flag=") && o.includes("discovery_candidate_sources_enabled"));
    const flagReads = db.reads.filter(isOurs), isR2Gate = (r: { table: string; ops: string[] }) => r.table === "feature_flags" && RANK_DESIGN_FLAGS.some((f) => r.ops.includes(`eq(flag=${f})`)); // §91: §78's six gating-flag reads (cached), its output unchanged
    const base = db.reads.filter((r) => !isOurs(r) && !isR2Gate(r)).map((r) => r.table), r2Gate = db.reads.filter(isR2Gate).map((r) => r.ops.find((o) => o.startsWith("eq(flag="))); assert.equal(new Set(r2Gate).size, r2Gate.length, `each §78 flag read at most once (${r2Gate.join(",")})`);
    const hr = sha(base); if (show) console.log("p2Reads", hr, JSON.stringify(tables));
    assert.equal(hr, GOLDEN_W10_R3.p2Reads);
    assert.ok(flagReads.length <= 1, `at most one §85 flag read (${flagReads.length})`);
  });

  it("P3. modifiers on (injected): the governor path", async () => {
    const modifiers = {
      ...inertModifiers("flag_off"), enabled: true, reason: "flag_on" as const,
      localMomentum: { [`db/${uuid(12)}`]: 0.7, "node/1004": 0.2 }, momentumScale: 1, explorationBudgetPct: 20,
    };
    const o = await rankForViewer(goldenPlaces(), goldenViewer(), { sc: null, served: false, modifiers, nowMs: NOW, candidateKey: "golden:w10r3" });
    assert.equal(o.stages.governor === "applied" || o.stages.governor === "observed", true, "precondition: the governor ran");
    const h = sha(await outcomeValues(o)); if (show) console.log("p3", h);
    assert.equal(h, GOLDEN_W10_R3.p3);
  });
});
import { RANK_DESIGN_FLAGS } from "../lib/discoveryRankFlags.js"; // §91 (W10-I): at the file end so no cited line moves
