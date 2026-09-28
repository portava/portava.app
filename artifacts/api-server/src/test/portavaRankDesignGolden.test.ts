/**
 * census-discovery §78 (lane W10-R2) — FLAG OFF IS BYTE-IDENTICAL.
 *
 * The golden at src/test/fixtures/portavaRankGolden.json was captured at
 * `debd5ad4f` from src/test/helpers/portavaRankGoldenScenarios.ts BEFORE any §78
 * edit to lib/portavaRank.ts or services/ranking/DiscoveryRankingService.ts.
 * It holds, per scenario, the sha256 of the rows' JSON (order, score, full
 * feature record, shortest round-trip doubles), so equal hashes mean
 * bit-identical output. (Re-captured once by §93, W11-X1, for A11: see the helper's header.)
 *
 *   G1  portavaRank with no §78 input: all forty scenarios hash as captured.
 *   G2  DRS on the discovery surface with the §78 flag ABSENT and PRESENT-FALSE:
 *       both DRS modes hash as captured — the dismissals seeded in the world
 *       are not read into the ranking.
 *   G3  the pipeline hook with every flag off: `applyRankDesigns` returns the
 *       same three objects, and ranking through it hashes as captured.
 *   G4  NOT VACUOUS: each §78 input, set alone, changes at least one hash.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/portavaRankDesignGolden.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  portavaRankGoldenDigest, drsGoldenDigest, goldenCandidates, goldenViewers, goldenRankOptions,
  GOLDEN_NOW_MS, goldenRow,
} from "./helpers/portavaRankGoldenScenarios.js";
import { rankCandidates, type RankCandidate, type ViewerContext, type RankOptions } from "../lib/portavaRank.js";
import { applyRankDesigns, loadRankDesigns, INERT_RANK_DESIGNS } from "../lib/discoveryRankDesigns.js";
import { invalidateRankDesignFlagCache } from "../lib/discoveryRankFlags.js";
import { objectiveForSurface } from "../lib/discoveryRankObjectives.js";
import { newWorld, worldClient, flag } from "./helpers/fakeDiscoveryWorld.js";

const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/portavaRankGolden.json", import.meta.url), "utf8")) as {
  hashes: Record<string, string>; sample: Record<string, unknown>; drs: Record<string, string>;
};

const hashRows = (rows: Array<{ candidate: RankCandidate; score: number; features: Record<string, number> }>): string =>
  createHash("sha256").update(JSON.stringify(rows.map((x) => goldenRow(x.candidate.id, x.score, x.features)))).digest("hex");  // the helper's canonical row (§90), so both hash the same bytes

beforeEach(() => invalidateRankDesignFlagCache());

describe("G — §78 flags off: portavaRank and DRS output is bit-identical to the pre-§78 tree", () => {
  it("G1 every portavaRank scenario hashes exactly as captured at debd5ad4f", () => {
    const now = portavaRankGoldenDigest();
    assert.equal(Object.keys(now.hashes).length, 40);
    assert.deepEqual(Object.keys(now.hashes).sort(), Object.keys(GOLDEN.hashes).sort());
    for (const k of Object.keys(GOLDEN.hashes)) assert.equal(now.hashes[k], GOLDEN.hashes[k], `scenario ${k} moved`);
    assert.deepEqual(now.sample, GOLDEN.sample, "the full sample scenario is identical row by row");
  });

  it("G2 DRS on `discovery`: flag absent and flag FALSE both hash as captured", async () => {
    assert.deepEqual(await drsGoldenDigest(), GOLDEN.drs, "flag row absent");
    invalidateRankDesignFlagCache();
    assert.deepEqual(await drsGoldenDigest([flag("discovery_feature_families_enabled", false)]), GOLDEN.drs, "flag row present and FALSE");
  });

  it("G3 the pipeline hook with every flag off returns the same objects and the same bytes", async () => {
    const world = newWorld({ tables: { feature_flags: [
      flag("discovery_surface_objectives_enabled", false), flag("discovery_engagement_integrity_enabled", false),
      flag("discovery_feature_families_enabled", false), flag("discovery_intent_term_enabled", false),
      flag("discovery_trip_match_enabled", false), flag("discovery_diversity_axes_enabled", false),
    ] } });
    const sc = worldClient(world);
    const cands = goldenCandidates();
    const designs = await loadRankDesigns(sc, {
      viewerId: "viewer-full", city: "lisbon", nowMs: GOLDEN_NOW_MS, intentMode: "tonight",
      places: cands.map((c) => ({ id: c.id, category: c.category, savedCount: c.likeCount })),
    });
    assert.equal(designs.active, false);
    assert.deepEqual([...new Set(world.reads)], ["feature_flags"], "flags off: the six flag reads and nothing else");
    assert.equal(world.reads.length, 6);
    for (const [vName, ctx] of Object.entries(goldenViewers())) {
      for (const [oName, opts] of Object.entries(goldenRankOptions())) {
        const c2 = cands.map((c) => ({ ...c }));
        const d = applyRankDesigns(c2, ctx, opts, designs);
        assert.equal(d.candidates, c2); assert.equal(d.ctx, ctx); assert.equal(d.opts, opts);
        assert.equal(hashRows(rankCandidates(d.candidates, d.ctx, d.opts)), GOLDEN.hashes[`rank:${vName}:${oName}`], `${vName}:${oName}`);
      }
    }
    const inert = applyRankDesigns(cands, goldenViewers().full, {}, INERT_RANK_DESIGNS);
    assert.equal(inert.candidates, cands);
  });

  it("G4 not vacuous: each §78 input, set alone, moves the full-viewer default scenario's hash", () => {
    const base = goldenViewers().full;
    const cands = goldenCandidates();
    const key = "rank:full:default";
    const variants: Array<[string, RankCandidate[], ViewerContext, RankOptions]> = [
      ["intent", cands, { ...base, intent: { source: "request", modes: [{ mode: "nearby", weights: { travel: 1 }, keywords: [] }], categoryHints: [] } }, {}],
      ["tripMatch", cands, { ...base, tripMatch: { "node/1001": 1, "node/1013": 0.5 } }, {}],
      ["negativeFeedback", cands, { ...base, negativeFeedback: { categoryDismissals: { food: 3 } } }, {}],
      ["explorationValue", cands, { ...base, explorationValue: true }, {}],
      ["engagementIntegrity", cands.map((c, i) => (i % 2 ? { ...c, engagementIntegrity: 0.2 } : c)), base, {}],
      ["trailIds", cands.map((c, i) => (i % 3 === 0 ? { ...c, trailIds: ["t0"] } : c)), base, { diversity: { trailPenalty: 0.5 } }],
      ["servedCount", cands.map((c, i) => ({ ...c, servedCount: i % 3 })), base, { diversity: { historyPenalty: 0.5 } }],
      ["objective", cands, base, { objective: objectiveForSurface("trending") }],
    ];
    for (const [name, c, ctx, opts] of variants) {
      assert.notEqual(hashRows(rankCandidates(c.map((x) => ({ ...x })), ctx, opts)), GOLDEN.hashes[key], `${name} must move the golden`);
    }
  });
});
