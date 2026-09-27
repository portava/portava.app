/**
 * census-discovery §62 (DV-52) — a Discovery serve records WHICH graph reading
 * produced its modifiers, and that record is provenance only.
 *
 * `05` §9: the graph is useful when "it remains explainable enough for
 * debugging". §59.1 found the confidence record (depth, tier, source, reason,
 * computed-at) and the momentum scale were dropped before `stages`, and the
 * confidence row is overwritten daily, so a past serve's graph input was lost.
 *
 * GOLDEN. The ranked orders, the stages JSON and a sha256 of every per-item
 * feature vector below were captured from the PRE-§62 engine (tree 838f56cb5)
 * with the inputs in ./discoveryPdeGraphReading.fixture.ts, before
 * lib/discoveryPde.ts was touched. The ranker hold (docs/discovery/ROADMAP.md,
 * 2026-08-15) permits this change only if it moves no order, weight, term or
 * threshold — so every one of those is pinned byte-for-byte:
 *
 *   G1  modifiers OFF: order, stages bytes and feature bytes are the pre-§62
 *       golden exactly; `graphReading` is not a key at all
 *   G2  modifiers ON: order and feature bytes are the pre-§62 golden exactly;
 *       stages are the golden plus ONLY `graphReading`, which carries the
 *       reading the modifiers consumed
 *   G3  an absent confidence record (the THIN default) is recorded as absent —
 *       null fields — with the thin scale and budget it produced
 *   G4  graphReadingOf copies, never reads: it is total over hostile values
 *   G5  the reading is keyed by computedAt, so two serves on either side of a
 *       rebuild are told apart
 *
 * Run: node --import tsx/esm --test src/test/discoveryPdeGraphReading.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rankForViewer, graphReadingOf } from "../lib/discoveryPde.js";
import type { DiscoveryModifiers } from "../lib/discoveryModifiers.js";
import { places, viewer, modifiersOn, modifiersOff, NOW_MS } from "./discoveryPdeGraphReading.fixture.js";

const GOLDEN = {
  off: {
    ranked: [
      "db/00000000-0000-4000-8000-000000000060", "node/622", "db/00000000-0000-4000-8000-000000000066", "node/625",
      "db/00000000-0000-4000-8000-000000000063", "node/624", "node/627", "node/621",
    ],
    stages: '{"portavaRank":true,"drs":true,"analytics":false,"suppressedWrites":0,"modifiers":"flag_off","governor":"skipped"}',
    featuresSha256: "2318b511edf3f4334ea3a13f4483b3502cb474e12b50d28293c5aee91272dd8a",
  },
  on: {
    ranked: [
      "db/00000000-0000-4000-8000-000000000060", "db/00000000-0000-4000-8000-000000000066", "node/622", "node/625",
      "node/621", "db/00000000-0000-4000-8000-000000000063", "node/624", "node/627",
    ],
    stages: '{"portavaRank":true,"drs":true,"analytics":false,"suppressedWrites":0,"modifiers":"flag_on","governor":"applied"}',
    featuresSha256: "cb4b69eae577edff2ad996dd8d3b7b1840accb307a66410a322481b5d7feaa1d",
  },
} as const;

async function snap(mods: DiscoveryModifiers) {
  const o = await rankForViewer(places(), viewer(), { sc: null, served: false, modifiers: mods, nowMs: NOW_MS });
  const features = [...o.scoredById.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, s]) => [id, s.score, s.features]);
  return {
    ranked: o.ranked.map((p) => p.id),
    stages: o.stages,
    featuresSha256: createHash("sha256").update(JSON.stringify(features)).digest("hex"),
  };
}

describe("PDE graph-reading provenance (census-discovery §62, DV-52)", () => {
  it("G1. modifiers OFF: the order, the stages bytes and the feature bytes are the pre-§62 golden — no graphReading key", async () => {
    const s = await snap(modifiersOff());
    assert.deepEqual(s.ranked, GOLDEN.off.ranked);
    assert.equal(JSON.stringify(s.stages), GOLDEN.off.stages, "the OFF stages serialise to the same bytes as before §62");
    assert.equal(Object.prototype.hasOwnProperty.call(s.stages, "graphReading"), false, "not even an undefined-valued key");
    assert.equal(s.featuresSha256, GOLDEN.off.featuresSha256);
  });

  it("G2. modifiers ON: the order and feature bytes are the pre-§62 golden; stages gain ONLY the reading the modifiers consumed", async () => {
    const s = await snap(modifiersOn());
    assert.deepEqual(s.ranked, GOLDEN.on.ranked, "provenance moved no item");
    assert.equal(s.featuresSha256, GOLDEN.on.featuresSha256, "and no weight, term or threshold");
    const { graphReading, ...rest } = s.stages as typeof s.stages & { graphReading?: unknown };
    assert.equal(JSON.stringify(rest), GOLDEN.on.stages, "everything but the new key is byte-identical");
    assert.deepEqual(graphReading, {
      city: "lisbon", depthScore: 41, tier: "moderate", source: "platform_coverage", sourceReason: "platform_coverage",
      computedAt: "2026-09-26T03:00:00.000Z", momentumScale: 0.705, explorationBudgetPct: 20.9,
    });
    assert.ok(!JSON.stringify(graphReading).includes("visitors"), "the aggregate signal vector is not copied into the serve record");
  });

  it("G3. an absent confidence record (a failed or empty read) is recorded as absent, beside the thin default it produced", async () => {
    const thin: DiscoveryModifiers = { ...modifiersOn(), cityConfidence: null, momentumScale: 0.5, explorationBudgetPct: 25 };
    const s = await snap(thin);
    assert.deepEqual((s.stages as any).graphReading, {
      city: null, depthScore: null, tier: null, source: null, sourceReason: null, computedAt: null,
      momentumScale: 0.5, explorationBudgetPct: 25,
    }, "null fields say no record was consulted; the scale and budget say what that absence produced");
  });

  it("G4. graphReadingOf copies, never reads, and is total over hostile values", () => {
    const hostile = {
      ...modifiersOn(),
      cityConfidence: { city: "", depthScore: Number.NaN, tier: undefined, signals: {}, computedAt: "", source: undefined } as any,
    };
    assert.deepEqual(graphReadingOf(hostile), {
      city: null, depthScore: null, tier: null, source: null, sourceReason: null, computedAt: null,
      momentumScale: 0.705, explorationBudgetPct: 20.9,
    });
    let reads = 0;
    const spy = new Proxy(modifiersOn(), { get(t, p, r) { if (p === "localMomentum" || p === "trailAffinity" || p === "trendStates") reads += 1; return Reflect.get(t, p, r); } });
    graphReadingOf(spy);
    assert.equal(reads, 0, "it touches only the confidence record and the two values derived from it");
  });

  it("G5. two serves either side of a nightly rebuild record two different readings", async () => {
    const before = await snap(modifiersOn());
    const rebuilt = modifiersOn();
    rebuilt.cityConfidence = { ...rebuilt.cityConfidence!, depthScore: 58, tier: "moderate", computedAt: "2026-09-27T03:00:00.000Z" };
    const after = await snap(rebuilt);
    const a = (before.stages as any).graphReading, b = (after.stages as any).graphReading;
    assert.notEqual(a.computedAt, b.computedAt);
    assert.deepEqual([a.depthScore, b.depthScore], [41, 58], "the log keeps what the overwritten row no longer can");
  });
});
