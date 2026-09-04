/**
 * CompassPipeline — Phase 2 single-entry-point orchestrator.
 *
 * Runs the gates in strict order for a batch of items:
 *   1. Safety Filter    → hard-block (fail-CLOSED on exceptions)
 *   2. Eligibility      → soft-reject (fail-OPEN on exceptions)
 *   2b. Live constraints → IG-07: Live intel as HARD constraints BEFORE ranking
 *                          (exclude / demote, fail-closed, gated OFF by default;
 *                          see CompassLiveConstraints.ts). An excluded item is
 *                          never scored, so no score can override it (AT-14).
 *   3. Privacy Guard    → sanitise (strip GPS, hotel addr, admin notes, etc.)
 *   4. Scoring Engine   → rank (per-type weighted formula)
 *   5. Plan B           → next-best same-category alternative for every pick a
 *                          live constraint took out or displaced.
 *
 * Feature flags are loaded once per pipeline call and shared across all gates.
 *
 * Returns only items that passed all gates, sorted by finalScore descending.
 *
 * Injectable gate functions (via _overrides) allow unit tests to verify
 * orchestration order and gate interactions without real DB or external calls.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile, CompassContext } from "./types.js";
import { runSafetyFilter } from "./CompassSafetyFilter.js";
import { runEligibilityCheck } from "./CompassEligibilityEngine.js";
import { sanitizeItem } from "./CompassPrivacyGuard.js";
import { scoreItem, type ScoreResult } from "./CompassScoringEngine.js";
import {
  annotateCandidate,
  loadMemoryPreferenceTags,
  type RankingFactor,
} from "./CompassRecommendationEngine.js";
import { getCityWorldModel, worldModelBoostForItem } from "./CompassGraphEngine.js";
import {
  computePlanB,
  prepareLiveIntelStage,
  type LiveConstraintDecision,
  type LiveIntelAnnotation,
  type LiveIntelStageOverrides,
  type PlanBConstrainedCandidate,
  type PlanBEntry,
} from "./CompassLiveConstraints.js";
import { logger } from "../lib/logger.js";

export interface PipelineResult {
  item:             CompassItem;
  finalScore:       number;
  safetyPassed:     true;
  eligiblePassed:   true;
  privacySanitized: true;
  /** Phase 7 — personal-fit score (0–100), independent of popularity. */
  compassMatch:     number;
  /** Phase 7 — community popularity score (0–100), viewer-independent. */
  communityScore:   number;
  /** Phase 7 — grounded factors that produced this ranking. */
  rankingFactors:   RankingFactor[];
  /**
   * IG-07 — live-intel annotation (constraint, forecasts, lines). Present only
   * when the live stage ran AND at least one qualifying envelope was served for
   * this item's canonical subject. Absent ⇒ "unknown", never "assumed fine".
   */
  liveIntel?:       LiveIntelAnnotation;
}

/** IG-07 decision-exposure record for a candidate a Live constraint excluded. */
export interface LiveExclusionRecord {
  itemId:   string;
  itemType: string;
  decision: LiveConstraintDecision;
}

/**
 * IG-07 — what the live stage did this call (§24 "recommendation candidates
 * before/after hard constraints"). `ran` is false when the gate was off, no DB,
 * or Live may not be served — in which case every list is empty and the
 * pipeline output is identical to the pre-IG-07 behaviour.
 */
export interface PipelineLiveConstraintsSummary {
  ran:             boolean;
  subjectsChecked: number;
  subjectsSkipped: number;
  excluded:        LiveExclusionRecord[];
  demoted:         Array<{ itemId: string; itemType: string; decision: LiveConstraintDecision }>;
  planB:           PlanBEntry[];
}

export interface PipelineSummary {
  inputCount:    number;
  blockedCount:  number;
  rejectedCount: number;
  passedCount:   number;
  results:       PipelineResult[];
  /** IG-07 — candidates a Live hard constraint excluded before ranking. */
  liveExcludedCount: number;
  liveConstraints:   PipelineLiveConstraintsSummary;
}

/** Injectable gate overrides for testing (do not use in production). */
export interface PipelineTestOverrides {
  safetyFilter?: (
    item: CompassItem,
    profile: CompassProfile,
    db: SupabaseClient | null,
    flags: Record<string, boolean>,
  ) => { allowed: boolean; reason?: string };
  eligibilityCheck?: (
    item: CompassItem,
    profile: CompassProfile,
    context: CompassContext,
    db: SupabaseClient | null,
    flags: Record<string, boolean>,
  ) => { eligible: boolean; reason?: string };
  scoreItem?: (
    item: CompassItem,
    profile: CompassProfile,
    context: CompassContext,
    db: SupabaseClient | null,
  ) => ScoreResult;
  /** IG-07 — synthetic envelopes / fixed clock / tolerances for the live stage. */
  liveIntel?: LiveIntelStageOverrides;
}

/** Load all COMPASS_ feature flags in a single DB query. */
async function loadFlags(db: SupabaseClient | null): Promise<Record<string, boolean>> {
  if (!db) return {};
  try {
    const { data } = await db
      .from("feature_flags")
      .select("flag, enabled")
      .like("flag", "COMPASS_%");
    const out: Record<string, boolean> = {};
    for (const row of (data as any[]) ?? []) {
      out[row.flag] = Boolean(row.enabled);
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "Compass feed: COMPASS_* feature flag lookup failed — degraded to all-defaults");
    return {};
  }
}

/**
 * Run the full Compass pipeline on a batch of items.
 *
 * @param items          Raw content items (unsanitized, unscored)
 * @param profile        The calling user's Compass profile (from Phase 1)
 * @param context        The resolved Compass context (from Phase 1)
 * @param db             Optional Supabase client for audit logging and flag loads
 * @param _testOverrides Injectable gate functions for unit tests only
 * @returns              PipelineSummary with results sorted by finalScore descending
 */
export async function runPipeline(
  items: CompassItem[],
  profile: CompassProfile,
  context: CompassContext,
  db: SupabaseClient | null = null,
  _testOverrides?: PipelineTestOverrides,
  circleMemoryTags?: Set<string>,
): Promise<PipelineSummary> {
  // Pre-load feature flags once for the whole batch
  const flags = await loadFlags(db);

  // Phase 7 — load memory-derived preference tags once per pipeline call.
  // Callers may pass pre-gated circle-scoped group memory tags (group
  // recommendations); those are kept separate so hits ground a
  // group-specific factor label, while the boost stays bounded either way.
  const memoryTags = await loadMemoryPreferenceTags(db, profile.userId);

  // Phase 15 — load the Destination World Model for the viewer's city once
  // per pipeline call. Fail-soft: a missing model contributes zero boost.
  const worldModel = await getCityWorldModel(db, profile.currentCity ?? null);
  const now = new Date();

  const safetyFn     = _testOverrides?.safetyFilter     ?? runSafetyFilter;
  const eligibilityFn = _testOverrides?.eligibilityCheck ?? runEligibilityCheck;
  const scoreFn      = _testOverrides?.scoreItem         ?? scoreItem;

  let blockedCount  = 0;
  let rejectedCount = 0;
  const results: PipelineResult[] = [];

  // Gates 1 + 2 first, for the whole batch, so the live stage reads intel only
  // for candidates that are still in play.
  const survivors: CompassItem[] = [];
  for (const item of items) {
    // Gate 1: Safety Filter (fail-CLOSED)
    const safety = safetyFn(item, profile, db, flags);
    if (!safety.allowed) {
      blockedCount++;
      continue;
    }

    // Gate 2: Eligibility Engine (fail-OPEN)
    const eligibility = eligibilityFn(item, profile, context, db, flags);
    if (!eligibility.eligible) {
      rejectedCount++;
      continue;
    }
    survivors.push(item);
  }

  // Gate 2b (IG-07): Live intel as HARD constraints, BEFORE privacy/scoring.
  // Null whenever the stage may not run (gate off / Live not servable) — then
  // nothing below changes. A stage failure is contained: it never throws into
  // the feed and never fabricates a claim.
  let liveStage: Awaited<ReturnType<typeof prepareLiveIntelStage>> = null;
  try {
    liveStage = await prepareLiveIntelStage(db, survivors, profile, _testOverrides?.liveIntel);
  } catch (err) {
    logger.warn({ err }, "Compass pipeline: live-intel stage failed — continuing without live constraints");
    liveStage = null;
  }
  const liveExcluded: LiveExclusionRecord[] = [];
  const liveDemoted: PipelineLiveConstraintsSummary["demoted"] = [];

  for (const item of survivors) {
    const liveIntel = liveStage?.annotations.get(item.id);

    // A Live EXCLUSION removes the candidate here — before it is sanitised or
    // scored. scoreItem is never called for it (no audit row), and there is no
    // score for any later stage to add back. This is AT-14.
    if (liveIntel?.constraint?.kind === "exclude") {
      liveExcluded.push({ itemId: item.id, itemType: String(item.type), decision: liveIntel.constraint });
      continue;
    }

    // Gate 3: Privacy Guard
    const sanitized = sanitizeItem(item, profile, db);

    // Gate 4: Scoring Engine
    const scored = scoreFn(sanitized, profile, context, db);

    // Phase 7 — Compass Match / Community Score / grounded ranking factors.
    // The memory-derived preference boost is bounded (0–5) so memories can
    // nudge but never dominate the rank.
    const annotation = annotateCandidate(sanitized, profile, memoryTags, circleMemoryTags);

    // Phase 15 — bounded, time-aware Destination World Model boost. The same
    // item ranks differently on a Friday night vs a Monday morning when the
    // city's graph history says its category peaks in the current time slice.
    const wm = worldModelBoostForItem(sanitized, worldModel, now);
    let rankingFactors = wm.factor
      ? [...annotation.factors, wm.factor]
      : annotation.factors;

    // IG-07 — a Live DEMOTION (queue above tolerance, packed vs quiet intent)
    // and any 'emerging' soft influence subtract a documented, bounded penalty;
    // the grounded live factors join the "Why this" factors.
    let livePenalty = 0;
    if (liveIntel) {
      livePenalty = liveIntel.penalty;
      if (liveIntel.factors.length > 0) rankingFactors = [...rankingFactors, ...liveIntel.factors];
      if (liveIntel.constraint?.kind === "demote") {
        liveDemoted.push({ itemId: item.id, itemType: String(item.type), decision: liveIntel.constraint });
      }
    }

    const result: PipelineResult = {
      item:             sanitized,
      finalScore:       Math.max(0, scored.finalScore + annotation.memoryBoost + wm.boost - livePenalty),
      safetyPassed:     true,
      eligiblePassed:   true,
      privacySanitized: true,
      compassMatch:     annotation.compassMatch,
      communityScore:   annotation.communityScore,
      rankingFactors,
    };
    if (liveIntel) result.liveIntel = liveIntel;
    results.push(result);
  }

  // Sort by finalScore descending
  results.sort((a, b) => b.finalScore - a.finalScore);

  // Gate 5 (IG-07): Plan B — the next-best same-category alternative for each
  // pick a Live constraint excluded or displaced. Excluded candidates never had
  // a score (they were never scored); demoted ones carry their pre-penalty score
  // so "did the constraint change the pick?" is decided honestly.
  let planB: PlanBEntry[] = [];
  if (liveStage && (liveExcluded.length > 0 || liveDemoted.length > 0)) {
    const excludedItems = new Map(survivors.map((i) => [i.id, i] as const));
    const constrained: PlanBConstrainedCandidate[] = [
      ...liveExcluded.map((e) => ({
        item: excludedItems.get(e.itemId)!,
        decision: e.decision,
        finalScore: null,
        unconstrainedScore: null,
      })),
      ...results
        .filter((r) => r.liveIntel?.constraint?.kind === "demote")
        .map((r) => ({
          item: r.item,
          decision: r.liveIntel!.constraint!,
          finalScore: r.finalScore,
          unconstrainedScore: r.finalScore + r.liveIntel!.penalty,
        })),
    ];
    planB = computePlanB(
      constrained,
      results.map((r) => ({ item: r.item, finalScore: r.finalScore, hasHardConstraint: !!r.liveIntel?.constraint })),
    );
    // §24 required log: candidates before/after hard constraints — counts and
    // reason codes only; no item content, no location, no identity.
    logger.info(
      {
        survivors: survivors.length,
        subjectsChecked: liveStage.subjectsChecked,
        excluded: liveExcluded.map((e) => e.decision.reasonCode),
        demoted: liveDemoted.map((d) => d.decision.reasonCode),
        planB: planB.length,
      },
      "Compass pipeline: live constraints applied",
    );
  }

  return {
    inputCount:   items.length,
    blockedCount,
    rejectedCount,
    passedCount:  results.length,
    results,
    liveExcludedCount: liveExcluded.length,
    liveConstraints: {
      ran:             liveStage !== null,
      subjectsChecked: liveStage?.subjectsChecked ?? 0,
      subjectsSkipped: liveStage?.subjectsSkipped ?? 0,
      excluded:        liveExcluded,
      demoted:         liveDemoted,
      planB,
    },
  };
}
