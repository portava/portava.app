/**
 * discoveryPipelineStages — census-discovery §85 (lane W10-R3), DC-11's two
 * other missing stages and H-P21-4's served reading:
 *
 *   L1–L4  learn from outcomes (`discovery_outcome_learning_enabled`, 3483)
 *   I1–I4  integrity checks (`discovery_integrity_stage_enabled`, 3483),
 *          calling DV-12's detector through the registration hook
 *   G1–G6  the served graph reading's provenance
 *          (`compass_city_confidence_windowed_reads_enabled`, 3484)
 *
 * CONTROLLED DATA; no claim of effectiveness is made or implied.
 *
 * Runtime: node:test + node:assert/strict.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rankForViewer } from "../lib/discoveryPde.js";
import { inertModifiers, invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import { PIPELINE_FLAGS_OFF, type PipelineFlags } from "../lib/discoveryCandidates/pipelineFlags.js";
import { applyLearnedShifts, learnedShifts, LEARNING_MAX_SHIFT, LEARNING_MIN_SERVED } from "../lib/discoveryCandidates/outcomeLearning.js";
import { registerEngagementIntegrityDetector, type EngagementIntegrityDetector } from "../lib/discoveryCandidates/integrity.js";
import { loadGraphReadingProvenance } from "../lib/discoveryCandidates/graphReadingProvenance.js";
import { pdeFeatureProvenanceFeatures } from "../lib/discoveryRankProvenance.js";
import type { CityConfidence } from "../compass/CompassGraphEngine.js";
import { makeFakeCandidateDb, type Row } from "./helpers/fakeCandidateDb.js";
import { NOW, pool, viewer, world, iso } from "./helpers/candidateWorld.js";

beforeEach(() => invalidateDiscoveryModifiersFlagCache());
afterEach(() => registerEngagementIntegrityDetector(null));

const served = (id: string, n: number, positive: number): Row[] =>
  Array.from({ length: n }, (_, k) => ({ item_id: id, surface: "discovery", outcome: k < positive ? "save" : "impression", served_at: iso(60_000 * (k + 1)) }));

describe("DC-11 — learn from outcomes", () => {
  it("L1. only an item with LEARNING_MIN_SERVED served rows moves, and never more than LEARNING_MAX_SHIFT places", () => {
    const counts = new Map([["a", { served: 100, positive: 60 }], ["b", { served: 100, positive: 1 }], ["c", { served: LEARNING_MIN_SERVED - 1, positive: 19 }]]);
    const shifts = learnedShifts(counts);
    assert.ok(shifts.has("a") && shifts.has("b") && !shifts.has("c"), "c has too little evidence");
    for (const s of shifts.values()) assert.ok(Math.abs(s.shift) <= LEARNING_MAX_SHIFT);
    const order = Array.from({ length: 12 }, (_, i) => (i === 10 ? "a" : i === 1 ? "b" : `x${i}`));
    const after = applyLearnedShifts(order, shifts);
    assert.ok(after.indexOf("a") >= 10 - LEARNING_MAX_SHIFT && after.indexOf("a") < 10, "a converts: it rises, boundedly");
    assert.ok(after.indexOf("b") > 1 && after.indexOf("b") <= 1 + LEARNING_MAX_SHIFT, "b is served and ignored: it sinks, boundedly");
  });

  it("L2. on the PDE path: the stage reads outcomes over a bounded window and records itself", async () => {
    const w = world();
    w["rank_events"] = [...served("node/107", 40, 30), ...served("node/100", 40, 0), ...served("node/101", 10, 10)];
    const off = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(w), served: true, nowMs: NOW, pipelineFlags: { ...PIPELINE_FLAGS_OFF } });
    const on = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(w), served: true, nowMs: NOW, pipelineFlags: { ...PIPELINE_FLAGS_OFF, outcomeLearning: true } });
    const L = on.stages.outcomeLearning!;
    assert.equal(L.status, "applied");
    assert.equal(L.itemsWithEvidence, 2, "node/101 has 10 rows: below the floor");
    assert.equal(L.window.endMs - L.window.startMs, 30 * 86_400_000);
    const pos = (o: typeof on, id: string) => o.ranked.findIndex((p) => p.id === id);
    assert.ok(pos(on, "node/107") < pos(off, "node/107"), "the converting row rises");
    assert.ok(Math.abs(pos(on, "node/107") - pos(off, "node/107")) <= LEARNING_MAX_SHIFT + 1);
    assert.equal(off.stages.outcomeLearning, undefined);
  });

  it("L3. a failed read leaves DRS's order and says read_failed", async () => {
    const flags: PipelineFlags = { ...PIPELINE_FLAGS_OFF, outcomeLearning: true };
    const base = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, pipelineFlags: { ...PIPELINE_FLAGS_OFF } });
    const o = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(world(), { erroring: ["rank_events"] }), served: true, nowMs: NOW, pipelineFlags: flags });
    assert.equal(o.stages.outcomeLearning!.status, "read_failed");
    assert.deepEqual(o.ranked.map((p) => p.id), base.ranked.map((p) => p.id));
  });
});

describe("DC-11 — integrity checks (DV-12's detector, lane W10-R2)", () => {
  const INT: PipelineFlags = { ...PIPELINE_FLAGS_OFF, integrityStage: true };

  it("I1. with no detector registered the stage says detector_absent and changes nothing", async () => {
    const base = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, pipelineFlags: { ...PIPELINE_FLAGS_OFF } });
    const o = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, pipelineFlags: INT });
    assert.equal(o.stages.integrity!.status, "detector_absent");
    assert.deepEqual(o.ranked.map((p) => p.id), base.ranked.map((p) => p.id));
  });

  it("I2. a registered detector's verdicts apply: withhold removes, discount sinks", async () => {
    const det: EngagementIntegrityDetector = async (_sc, items) => new Map([[items[0]!.id, "discount"], ["node/5", "withhold"]]);
    registerEngagementIntegrityDetector(det);
    const o = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, pipelineFlags: INT });
    const ids = o.ranked.map((p) => p.id);
    assert.ok(!ids.includes("node/5"), "withheld");
    assert.equal(o.stages.integrity!.status, "applied");
    assert.equal(o.stages.integrity!.withheld, 1);
    assert.equal(o.stages.integrity!.discounted, 1);
    assert.equal(ids[ids.length - 1], `db/00000000-0000-4000-8000-000000000001`, "the discounted head row sinks to the foot");
  });

  it("I3. a detector that throws or answers null changes nothing", async () => {
    const base = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, pipelineFlags: { ...PIPELINE_FLAGS_OFF } });
    for (const det of [async () => { throw new Error("x"); }, async () => null] as EngagementIntegrityDetector[]) {
      const o = await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, pipelineFlags: INT, integrityDetector: det });
      assert.equal(o.stages.integrity!.status, "detector_failed");
      assert.deepEqual(o.ranked.map((p) => p.id), base.ranked.map((p) => p.id));
    }
  });

  it("I4. with the flag OFF a registered detector is never called", async () => {
    let called = 0;
    registerEngagementIntegrityDetector(async () => { called++; return new Map(); });
    await rankForViewer(pool(), viewer(), { sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, pipelineFlags: { ...PIPELINE_FLAGS_OFF } });
    assert.equal(called, 0);
  });
});

describe("H-P21-4 — the served graph reading carries all four facts", () => {
  const COMPUTED = "2026-09-28T03:00:00.000Z";
  const reading = (over: Partial<CityConfidence> = {}): CityConfidence => ({
    city: "miami", depthScore: 42, tier: "moderate", signals: {}, computedAt: COMPUTED, source: "compass_graph", sourceReason: "platform_no_rows", platformCells: 0, ...over,
  });
  const WINDOW = { kind: "unbounded_start", startMs: null, endMs: Date.parse(COMPUTED), truncated: false, rows: {} };
  const confRow = (over: Row = {}): Row => ({ city: "miami", computed_at: "2026-09-28T03:00:00+00:00", model_version: "compass-city-depth-v1", feature_version: "compass-city-depth-signals-v1", source_window: WINDOW, ...over });
  const mods = (c: CityConfidence) => ({ ...inertModifiers("flag_off"), enabled: true, reason: "flag_on" as const, cityConfidence: c, explorationBudgetPct: 20, momentumScale: 1 });
  const G: PipelineFlags = { ...PIPELINE_FLAGS_OFF, graphReadingProvenance: true };
  const gr = (o: { depthScore: number | null }) => ({ city: "miami", depthScore: o.depthScore, tier: "moderate", source: "compass_graph", sourceReason: "platform_no_rows", computedAt: COMPUTED, momentumScale: 1, explorationBudgetPct: 20 });

  it("G1. recorded: model version, feature version, window, computation time — for the SAME reading", async () => {
    const p = await loadGraphReadingProvenance(makeFakeCandidateDb({ compass_city_confidence: [confRow()] }), gr({ depthScore: 42 }));
    assert.deepEqual(p, { status: "recorded", modelVersion: "compass-city-depth-v1", featureVersion: "compass-city-depth-signals-v1", sourceWindow: WINDOW, computedAt: COMPUTED });
  });
  it("G2. the platform's reading is not stamped with Compass's versions (§75.3 blocker 3)", async () => {
    const p = await loadGraphReadingProvenance(makeFakeCandidateDb({ compass_city_confidence: [confRow()] }), { ...gr({ depthScore: 42 }), source: "platform_coverage" });
    assert.deepEqual(p, { status: "platform_producer" });
  });
  it("G3. a row written with the flag off, a moved reading, and an unapplied 3484 each say so", async () => {
    assert.equal((await loadGraphReadingProvenance(makeFakeCandidateDb({ compass_city_confidence: [confRow({ model_version: null })] }), gr({ depthScore: 1 }))).status, "not_recorded");
    assert.equal((await loadGraphReadingProvenance(makeFakeCandidateDb({ compass_city_confidence: [confRow({ computed_at: "2026-09-28T04:00:00Z" })] }), gr({ depthScore: 1 }))).status, "reading_moved");
    assert.equal((await loadGraphReadingProvenance(makeFakeCandidateDb({ compass_city_confidence: [confRow()] }, { missingColumns: { compass_city_confidence: ["model_version"] } }), gr({ depthScore: 1 }))).status, "columns_absent");
  });
  it("G4. on the PDE path: stages.graphReading and every scored row carry the record", async () => {
    const db = makeFakeCandidateDb({ ...world(), compass_city_confidence: [confRow()] });
    const o = await rankForViewer(pool(), viewer(), { sc: db, served: true, nowMs: NOW, modifiers: mods(reading()), pipelineFlags: G });
    assert.equal(o.stages.graphReading!.provenance!.status, "recorded");
    const f = pdeFeatureProvenanceFeatures(o.scoredById.get("node/5")!);
    assert.equal((f["graphReadingProvenance"] as { modelVersion: string }).modelVersion, "compass-city-depth-v1");
  });
  it("G5. with the flag off the reading is byte-identical: no provenance key, no read", async () => {
    const db = makeFakeCandidateDb({ ...world(), compass_city_confidence: [confRow()] });
    const o = await rankForViewer(pool(), viewer(), { sc: db, served: true, nowMs: NOW, modifiers: mods(reading()), pipelineFlags: { ...PIPELINE_FLAGS_OFF } });
    assert.ok(!("provenance" in o.stages.graphReading!));
    assert.equal(db.reads.filter((r) => r.table === "compass_city_confidence").length, 0);
  });
  it("G6. with the modifiers off there is no reading and nothing is read", async () => {
    const db = makeFakeCandidateDb({ ...world(), compass_city_confidence: [confRow()] });
    const o = await rankForViewer(pool(), viewer(), { sc: db, served: true, nowMs: NOW, pipelineFlags: G });
    assert.equal(o.stages.graphReading, undefined);
    assert.equal(db.reads.filter((r) => r.table === "compass_city_confidence").length, 0);
  });
});
