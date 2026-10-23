/**
 * census-discovery §94 (lane W11-X2), DC-17 / W11A-B7 — the platform producer
 * path's graph reading retains all four `10` §5 facts, behind
 * `discovery_platform_graph_provenance_enabled` (3490, seeded FALSE).
 *
 *   P0  flag OFF / absent: `{ status: "platform_producer" }`, and no snapshot is read
 *   P1  flag ON, the same reading: recorded — model version, feature version,
 *       window and computation time
 *   P2  the producer rewrote a cell between the two reads: reading_moved
 *   P3  the depth no longer folds to the reading's: reading_moved
 *   P4  the re-read reaches the governing read's cap: no claim (platform_producer)
 *   P5  a failed read: read_failed; a throw: read_failed
 *   P6  another city's cell under the same prefix is not counted
 *   W1  WIRED: loadGraphReadingProvenance answers the platform record for a
 *       `platform_coverage` reading (flag ON) and the old answer with it OFF
 *   V1  the fold's version is pinned to `platformCoverageDepthScore` and
 *       `tierForScore`; the feature version to `coverageState`; the cap to the
 *       engine's own constant
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryPlatformGraphProvenance.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  platformGraphReadingProvenance, PLATFORM_COVERAGE_FOLD_MODEL_VERSION, PLATFORM_COVERAGE_FEATURE_VERSION, PLATFORM_COVERAGE_READ_CAP,
} from "../lib/discoveryPlatformGraphProvenance.js";
import { loadGraphReadingProvenance } from "../lib/discoveryCandidates/graphReadingProvenance.js";
import { platformCoverageDepthScore, tierForScore } from "../compass/CompassGraphEngine.js";
import { coverageState } from "../lib/coverageScore.js";
import type { PdeGraphReading } from "../lib/discoveryPde.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const NEWEST = "2026-09-28T11:50:00.000Z";
const OLDEST = "2026-09-28T11:20:00.000Z";

function cell(over: Record<string, unknown> = {}) {
  return { city: "Miami", zone_id: "z1", claim_family: "crowd.level", coverage_state: "covered", current_confidence: 0.8, score: 0.2, computed_at: NEWEST, expires_at: "2026-09-28T12:50:00.000Z", ...over };
}
const CELLS = [cell(), cell({ zone_id: "z2", coverage_state: "no_coverage", current_confidence: 0.1, computed_at: OLDEST }), cell({ zone_id: "z3", coverage_state: "unknown", current_confidence: 0.4, computed_at: "2026-09-28T11:40:00.000Z" })];
const DEPTH = platformCoverageDepthScore({ cells: 3, covered: 1, meanConfidence: Math.round(((0.8 + 0.1 + 0.4) / 3) * 10000) / 10000 });

function reading(over: Partial<PdeGraphReading> = {}): PdeGraphReading {
  return { city: "miami", depthScore: DEPTH, tier: tierForScore(DEPTH), source: "platform_coverage", sourceReason: null, computedAt: NEWEST, momentumScale: 1, explorationBudgetPct: 0, ...over };
}

function client(opts: { flag?: boolean | null; cells?: any[]; error?: boolean; throws?: boolean }) {
  const reads: string[] = [];
  return {
    reads,
    from(table: string) {
      reads.push(table);
      if (table === "feature_flags") {
        const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: opts.flag == null ? null : { enabled: opts.flag }, error: null }) };
        return q;
      }
      if (table === "intel_coverage_snapshots") {
        if (opts.throws) throw new Error("socket hang up");
        const q: any = {
          select: () => q, ilike: () => q, gt: () => q, limit: () => q,
          then: (res: any) => res(opts.error ? { data: null, error: { message: "boom" } } : { data: opts.cells ?? CELLS, error: null }),
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe("DC-17 — the platform path's graph reading records its own four facts (3490 flag)", () => {
  it("P0 flag OFF or absent: the answer before §94, and no snapshot is read", async () => {
    for (const flag of [false, null]) {
      const sc = client({ flag });
      assert.deepEqual(await platformGraphReadingProvenance(sc, reading(), NOW), { status: "platform_producer" });
      assert.equal(sc.reads.includes("intel_coverage_snapshots"), false);
    }
  });

  it("P1 flag ON, the same reading: all four facts", async () => {
    const out = await platformGraphReadingProvenance(client({ flag: true }), reading(), NOW);
    assert.deepEqual(out, {
      status: "recorded",
      modelVersion: PLATFORM_COVERAGE_FOLD_MODEL_VERSION,
      featureVersion: PLATFORM_COVERAGE_FEATURE_VERSION,
      sourceWindow: { kind: "bounded", startMs: Date.parse(OLDEST), endMs: NOW.getTime(), truncated: false, rows: { intel_coverage_snapshots: 3 } },
      computedAt: NEWEST,
    });
  });

  it("P2 a cell rewritten between the two reads: reading_moved", async () => {
    const moved = [cell({ computed_at: "2026-09-28T11:59:00.000Z" }), ...CELLS.slice(1)];
    assert.deepEqual(await platformGraphReadingProvenance(client({ flag: true, cells: moved }), reading(), NOW), { status: "reading_moved" });
    assert.deepEqual(await platformGraphReadingProvenance(client({ flag: true, cells: [] }), reading(), NOW), { status: "reading_moved" });
  });

  it("P3 the cells no longer fold to the reading's depth: reading_moved", async () => {
    assert.deepEqual(await platformGraphReadingProvenance(client({ flag: true }), reading({ depthScore: DEPTH + 1 }), NOW), { status: "reading_moved" });
  });

  it("P4 the re-read reaches the governing read's cap: no window can be named, so no claim", async () => {
    const capped = Array.from({ length: PLATFORM_COVERAGE_READ_CAP }, (_, i) => cell({ zone_id: `z${i}` }));
    assert.deepEqual(await platformGraphReadingProvenance(client({ flag: true, cells: capped }), reading(), NOW), { status: "platform_producer" });
  });

  it("P5 a failed read and a throw are read_failed", async () => {
    assert.deepEqual(await platformGraphReadingProvenance(client({ flag: true, error: true }), reading(), NOW), { status: "read_failed" });
    assert.deepEqual(await platformGraphReadingProvenance(client({ flag: true, throws: true }), reading(), NOW), { status: "read_failed" });
  });

  it("P6 another city under the same prefix is not counted (the governing read's own rule)", async () => {
    const withOther = [...CELLS, cell({ city: "Miami Beach", zone_id: "zb", computed_at: "2026-09-28T11:55:00.000Z" })];
    const out = await platformGraphReadingProvenance(client({ flag: true, cells: withOther }), reading(), NOW);
    assert.equal(out.status, "recorded", JSON.stringify(out));
    assert.equal(out.computedAt, NEWEST);
  });

  it("W1 WIRED: loadGraphReadingProvenance answers the platform record ON, and the old answer OFF", async () => {
    assert.equal((await loadGraphReadingProvenance(client({ flag: true }), reading())).status, "recorded");
    assert.deepEqual(await loadGraphReadingProvenance(client({ flag: false }), reading()), { status: "platform_producer" });
    // census-discovery §131: a reading that names no store is `source_unknown`, flag or not — never the platform's answer.
    assert.deepEqual(await loadGraphReadingProvenance(client({ flag: true }), reading({ source: null })), { status: "source_unknown" });
  });

  it("V1 the versions are pinned to the code they name, and the cap to the engine's", () => {
    // The fold: a grid of inputs through platformCoverageDepthScore and tierForScore.
    const grid: string[] = [];
    for (const cells of [1, 3, 10]) for (const covered of [0, 1, cells]) for (const conf of [0, 0.25, 0.5, 1]) {
      const d = platformCoverageDepthScore({ cells, covered: Math.min(covered, cells), meanConfidence: conf });
      grid.push(`${cells}/${covered}/${conf}=${d}:${tierForScore(d)}`);
    }
    const foldDigest = createHash("sha256").update(grid.join("|")).digest("hex").slice(0, 16);
    assert.deepEqual({ v: PLATFORM_COVERAGE_FOLD_MODEL_VERSION, foldDigest }, { v: "compass-platform-coverage-fold-v1", foldDigest: "2756881492f31cdb" },
      "platformCoverageDepthScore or tierForScore changed: bump PLATFORM_COVERAGE_FOLD_MODEL_VERSION and re-pin");
    // One cell's contribution: its coverage_state as the platform computes it.
    const states: string[] = [];
    for (const claimMissing of [true, false]) for (const r of [null, 0, 0.5, 1, 1.5]) states.push(coverageState({ claimMissing, freshestAgeRatio: r }));
    assert.deepEqual({ v: PLATFORM_COVERAGE_FEATURE_VERSION, states: states.join(",") }, { v: "intel-coverage-cell-state-v1", states: "no_coverage,no_coverage,no_coverage,no_coverage,no_coverage,unknown,covered,covered,covered,no_coverage" },
      "coverageState changed: bump PLATFORM_COVERAGE_FEATURE_VERSION and re-pin");
    const engine = readFileSync(new URL("../compass/CompassGraphEngine.ts", import.meta.url), "utf8");
    assert.match(engine, new RegExp(`const PLATFORM_COVERAGE_READ_LIMIT = ${PLATFORM_COVERAGE_READ_CAP};`));
    assert.match(engine, /\.select\("city, zone_id, claim_family, coverage_state, current_confidence, score, computed_at, expires_at"\)/,
      "the governing read's projection moved: re-align lib/discoveryPlatformGraphProvenance.ts");
  });
});

// ── census-discovery §131 (lane DISCOVERY, 2026-10-23): a reading with NO store is not the platform's ──
//
// Production, read 2026-10-23: all 140 signed-in impressions served after the
// flag flip (Đà Nẵng) stored `graphSource: null`, `graphTier: null`,
// `graphDepth: null` and `graphProvenance: { status: "platform_producer" }`.
// `compass_city_confidence` has no `da nang` row and the platform store had no
// cell, so `getCityConfidence` answered null — "neither store had anything"
// (compass/CompassGraphEngine.ts) — and the record then claimed the PLATFORM's
// coverage store answered. It did not. N1, N2 and N4 (and W1's third
// assertion) are red at `18bf93ca7`; N3, N5 and N6 hold either way.
import { getCityConfidence } from "../compass/CompassGraphEngine.js";
import { graphReadingOf } from "../lib/discoveryPde.js";
import { inertModifiers } from "../lib/discoveryModifiers.js";

/** Both stores empty: compass_city_confidence has no row, intel_coverage_snapshots no cell. */
function emptyStores() {
  const reads: string[] = [];
  return {
    reads,
    from(table: string) {
      reads.push(table);
      const q: any = {
        select: () => q, eq: () => q, ilike: () => q, gt: () => q, limit: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (res: any) => res({ data: [], error: null }),
      };
      return q;
    },
  };
}
const modifiersOver = (cityConfidence: any) => ({ ...inertModifiers("flag_off"), enabled: true, reason: "flag_on" as const, cityConfidence, momentumScale: 0.5, explorationBudgetPct: 25 });

describe("§131 — a graph reading that names no store records source_unknown, never platform_producer", () => {
  it("N1 the production path: no row in either store ⇒ null confidence ⇒ the record says source_unknown", async () => {
    const conf = await getCityConfidence(emptyStores() as any, "Đà Nẵng", NOW);
    assert.equal(conf, null, "precondition: with both stores empty the loader answers null");
    const r = graphReadingOf(modifiersOver(conf) as any);
    assert.equal(r.source, null);
    assert.deepEqual(await loadGraphReadingProvenance(client({ flag: true }), r), { status: "source_unknown" });
    assert.deepEqual(await loadGraphReadingProvenance(client({ flag: false }), r), { status: "source_unknown" });
  });
  it("N2 a record built before CPV2-12 (a depth, no source) names no store either", async () => {
    const r = graphReadingOf(modifiersOver({ city: "da nang", depthScore: 12, tier: "thin", signals: {}, computedAt: NEWEST }) as any);
    assert.equal(r.source, null);
    assert.equal((await loadGraphReadingProvenance(client({ flag: true }), r)).status, "source_unknown");
  });
  it("N3 a sourceless reading reads nothing to reach its answer", async () => {
    const sc = client({ flag: true });
    await loadGraphReadingProvenance(sc, reading({ source: null }));
    assert.deepEqual(sc.reads, []);
  });
  it("N4 the claim 'the platform's coverage store answered' is made only for a platform_coverage reading", async () => {
    for (const source of [null, undefined, "", "compass_city_confidence"] as any[]) {
      const status = (await loadGraphReadingProvenance(client({ flag: false }), reading({ source }))).status;
      assert.notEqual(status, "platform_producer", `source=${JSON.stringify(source)} claimed the platform`);
    }
  });
  it("N5 control: a platform_coverage reading with 3490 OFF is still platform_producer (the platform did answer)", async () => {
    assert.deepEqual(await loadGraphReadingProvenance(client({ flag: false }), reading()), { status: "platform_producer" });
  });
  it("N6 control: a compass_graph reading still takes the Compass path (no row ⇒ reading_moved)", async () => {
    assert.deepEqual(await loadGraphReadingProvenance(emptyStores() as any, reading({ source: "compass_graph" })), { status: "reading_moved" });
  });
});
