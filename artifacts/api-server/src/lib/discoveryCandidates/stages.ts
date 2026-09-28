/**
 * The §85 stages, as `rankForViewer` calls them — census-discovery §85 (lane
 * W10-R3). `06` §1's pipeline, with where each §85 stage sits:
 *
 *   1 context assembly         loadPdeViewer (unchanged) + COLD START (3482)
 *   2 candidate generation     the caller's pool + the §85 RETRIEVALS (3480)
 *   3 eligibility              the route's pre-filters; materialize.ts applies
 *                              the same rules to every generated row
 *   4–5 features, scoring      portavaRank → DRS (unchanged)
 *   10→5 learn from outcomes   OUTCOME LEARNING, a bounded nudge (3483)
 *   6 diversity/exploration    portavaRank's diversity (unchanged) + the
 *                              RESERVED INVENTORY (3481), outside 2289
 *   7 integrity checks         the INTEGRITY STAGE, calling DV-12's detector
 *                              when one is registered (3483)
 *   8–9 serve, log             the route (unchanged); every row carries its
 *                              candidate sources and reserve bucket
 *
 * EVERY STAGE IS OFF UNLESS ITS FLAG IS ON, and with all of them off
 * `pdePreRankStages` returns the caller's own `places` and `viewer` objects and
 * writes no `stages` key, `pdeLearningStage` and `pdePostRankStages` touch
 * nothing, and the only cost is the one flag read (flags.ts).
 * src/test/discoveryCandidatePipelineGolden.test.ts holds that to hashes
 * captured before §85.
 */
import type { PdePlace, PdeViewer, PdeStages, PdeRankOptions } from "../discoveryPde.js";
import type { RankCandidate, ScoredCandidate } from "../portavaRank.js";
import type { DiscoveryModifiers } from "../discoveryModifiers.js";
import { stampPdeItemPipeline } from "../discoveryRankProvenance.js";
import { anyPipelineFlag, loadPipelineFlags, PIPELINE_FLAGS_OFF, type PipelineFlags } from "./pipelineFlags.js";
import type { PdeCandidateSource } from "./candidateSources.js";
import { generateCandidates } from "./generate.js";
import { applyColdStart } from "./viewerColdStart.js";
import { allocateReservedInventory, loadInventoryBuckets, INVENTORY_DEFAULT_BUDGET_PCT, type InventoryBucket } from "./explorationInventory.js";
import { applyLearnedShifts, loadLearnedShifts } from "./outcomeLearning.js";
import { applyIntegrityVerdicts, registeredEngagementIntegrityDetector, runIntegrityStage } from "./integrity.js";
import { loadGraphReadingProvenance } from "./graphReadingProvenance.js";

export interface PdePipelineState {
  flags: PipelineFlags;
  /** Every candidate's attribution, when generation ran. */
  sourcesById: Map<string, PdeCandidateSource[]> | null;
  /** Submitters of generated authored rows (PDE-internal). */
  submitterById: Map<string, string>;
  /** DV-53: the reserved inventory owns exploration on this run, so portavaRank's random slot and the governor stand down. */
  explorationOwnedByInventory: boolean;
}

const INERT: PdePipelineState = { flags: { ...PIPELINE_FLAGS_OFF }, sourcesById: null, submitterById: new Map(), explorationOwnedByInventory: false };

/** Reorder `list` in place to `order` (ids); ids absent from `order` are removed. */
function reorderInPlace<T extends { id: string }>(list: T[], order: readonly string[]): void {
  const byId = new Map(list.map((p) => [p.id, p]));
  const next = order.map((id) => byId.get(id)).filter((p): p is T => p !== undefined);
  list.splice(0, list.length, ...next);
}

const moved = (a: readonly string[], b: readonly string[]) => a.reduce((n, id, i) => n + (b[i] === id ? 0 : 1), 0);

/** Stages 1–2. Returns the caller's own objects when every §85 flag is off. */
export async function pdePreRankStages<T extends PdePlace>(
  rawSc: any, sc: any, places: T[], viewer: PdeViewer, opts: PdeRankOptions, nowMs: number, stages: PdeStages,
): Promise<{ places: T[]; viewer: PdeViewer; pipe: PdePipelineState }> {
  const flags = opts.pipelineFlags ?? await loadPipelineFlags(rawSc, nowMs);
  if (!anyPipelineFlag(flags)) return { places, viewer, pipe: INERT };
  const pipe: PdePipelineState = { flags, sourcesById: null, submitterById: new Map(), explorationOwnedByInventory: flags.explorationInventory };

  if (flags.coldStart) {
    try {
      const cs = await applyColdStart(sc, viewer);
      viewer = cs.viewer; stages.coldStart = cs.report;
    } catch { stages.coldStart = { cold: false, applied: false, seeded: { onboarding: 0, tripContext: 0 }, local: "none", degraded: ["profile", "trip_ideas"] }; }
  }

  if (flags.candidateSources) {
    // The Map reader and every shadow run pass served:false and must not ADD
    // rows (lib/mapDiscoveryCandidates: a projection "can neither resurrect an
    // object a gate removed nor add one"); generation runs where the result is
    // what the viewer receives, unless the caller says otherwise.
    if (opts.generateCandidates ?? opts.served) {
      try {
        const g = await generateCandidates(sc, places, viewer, { nowMs, category: opts.category, circle: flags.circleCandidates });
        places = g.places; pipe.sourcesById = g.sourcesById; pipe.submitterById = g.submitterById;
        stages.candidateGeneration = g.report;
      } catch {
        stages.candidateGeneration = { skipped: "threw", sources: {}, generated: 0, admittedCategories: "all", materialiseFailedReads: [], refused: { blocked: 0, standing: 0, demo: 0, category: 0 } };
      }
    } else {
      stages.candidateGeneration = { skipped: "not_served", sources: {}, generated: 0, admittedCategories: "all", materialiseFailedReads: [], refused: { blocked: 0, standing: 0, demo: 0, category: 0 } };
    }
  }
  return { places, viewer, pipe };
}

/** Stage 10 feeding back into the served order, after DRS. */
export async function pdeLearningStage<T extends PdePlace>(pipe: PdePipelineState, sc: any, ranked: T[], stages: PdeStages, nowMs: number): Promise<void> {
  if (!pipe.flags.outcomeLearning) return;
  try {
    const before = ranked.map((p) => p.id);
    const { shifts, report } = await loadLearnedShifts(sc, before, nowMs);
    if (shifts.size > 0) {
      const after = applyLearnedShifts(before, shifts);
      reorderInPlace(ranked, after);
      report.moved = moved(before, after);
    }
    stages.outcomeLearning = report;
  } catch { /* never fatal: the order is DRS's */ }
}

/** Stages 6 (the reserved inventory) and 7 (integrity), and the per-row records. */
export async function pdePostRankStages<T extends PdePlace>(
  pipe: PdePipelineState, sc: any, ranked: T[], scoredById: Map<string, ScoredCandidate<RankCandidate>>,
  viewer: PdeViewer, modifiers: DiscoveryModifiers, stages: PdeStages, nowMs: number, opts: PdeRankOptions,
): Promise<void> {
  if (pipe === INERT) return;

  if (pipe.flags.explorationInventory) {
    try {
      const ids = ranked.map((p) => p.id);
      const read = await loadInventoryBuckets(sc, ids, { nowMs, submitterById: pipe.submitterById });
      const budgetPct = modifiers.enabled ? modifiers.explorationBudgetPct : INVENTORY_DEFAULT_BUDGET_PCT;
      const inv = allocateReservedInventory(
        ranked.map((p) => ({ id: p.id, score: scoredById.get(p.id)?.score ?? Number.NEGATIVE_INFINITY, buckets: read.buckets.get(p.id) ?? [] as InventoryBucket[] })),
        { userId: viewer.userId, budgetPct, nowMs },
      );
      if (inv.applied) reorderInPlace(ranked, inv.order);
      for (const a of inv.allocations) { const s = scoredById.get(a.id); if (s) stampPdeItemPipeline(s, { explorationReserve: a.bucket }); }
      stages.explorationInventory = {
        status: inv.applied ? "applied" : inv.allocations.length > 0 ? "observed" : "skipped",
        budgetPct: inv.budgetPct, slotCount: inv.slotCount, floor: inv.floor,
        placed: inv.allocations.length, moved: inv.allocations.filter((a) => a.slotIndex < a.fromIndex).length,
        bucketMembers: inv.bucketMembers, eligible: inv.eligible, failedReads: read.failedReads,
      };
    } catch {
      stages.explorationInventory = { status: "skipped", budgetPct: 0, slotCount: 0, floor: null, placed: 0, moved: 0, bucketMembers: { new_creator: 0, low_exposure: 0, emerging_place: 0, new_trail: 0 }, eligible: { new_creator: 0, low_exposure: 0, emerging_place: 0, new_trail: 0 }, failedReads: ["threw"] };
    }
  }

  if (pipe.flags.integrityStage) {
    const detector = opts.integrityDetector !== undefined ? opts.integrityDetector : registeredEngagementIntegrityDetector();
    const items = ranked.map((p) => ({ id: p.id, savedCount: p.savedCount ?? null, category: p.category ?? null }));
    const { verdicts, report } = await runIntegrityStage(detector, sc, items, { viewerId: viewer.userId, nowMs });
    if (verdicts) {
      const r = applyIntegrityVerdicts(ranked.map((p) => p.id), verdicts);
      reorderInPlace(ranked, r.order);
      report.discounted = r.discounted; report.withheld = r.withheld;
      report.status = r.discounted + r.withheld > 0 ? "applied" : "clean";
    }
    stages.integrity = report;
  }

  if (pipe.sourcesById) {
    for (const [id, s] of scoredById) stampPdeItemPipeline(s, { candidateSources: pipe.sourcesById.get(id) ?? ["caller_pool"] });
  }

  if (pipe.flags.graphReadingProvenance && modifiers.enabled && stages.graphReading) {
    const prov = await loadGraphReadingProvenance(sc, stages.graphReading);
    stages.graphReading = { ...stages.graphReading, provenance: prov };
    const rec = { ...prov } as Record<string, unknown>;
    for (const s of scoredById.values()) stampPdeItemPipeline(s, { graphReadingProvenance: rec });
  }
}
