/**
 * CompassPipeline — Phase 2 single-entry-point orchestrator.
 *
 * Runs the four gates in strict order for a batch of items:
 *   1. Safety Filter  → hard-block (fail-CLOSED on exceptions)
 *   2. Eligibility    → soft-reject (fail-OPEN on exceptions)
 *   3. Privacy Guard  → sanitise (strip GPS, hotel addr, admin notes, etc.)
 *   4. Scoring Engine → rank (per-type weighted formula)
 *
 * Feature flags are loaded once per pipeline call and shared across all gates.
 *
 * Returns only items that passed all four gates, sorted by finalScore descending.
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
}

export interface PipelineSummary {
  inputCount:    number;
  blockedCount:  number;
  rejectedCount: number;
  passedCount:   number;
  results:       PipelineResult[];
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
  } catch {
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
    const rankingFactors = wm.factor
      ? [...annotation.factors, wm.factor]
      : annotation.factors;

    results.push({
      item:             sanitized,
      finalScore:       scored.finalScore + annotation.memoryBoost + wm.boost,
      safetyPassed:     true,
      eligiblePassed:   true,
      privacySanitized: true,
      compassMatch:     annotation.compassMatch,
      communityScore:   annotation.communityScore,
      rankingFactors,
    });
  }

  // Sort by finalScore descending
  results.sort((a, b) => b.finalScore - a.finalScore);

  return {
    inputCount:   items.length,
    blockedCount,
    rejectedCount,
    passedCount:  results.length,
    results,
  };
}
