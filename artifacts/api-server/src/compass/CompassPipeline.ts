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

export interface PipelineResult {
  item:             CompassItem;
  finalScore:       number;
  safetyPassed:     true;
  eligiblePassed:   true;
  privacySanitized: true;
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
): Promise<PipelineSummary> {
  // Pre-load feature flags once for the whole batch
  const flags = await loadFlags(db);

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

    results.push({
      item:             sanitized,
      finalScore:       scored.finalScore,
      safetyPassed:     true,
      eligiblePassed:   true,
      privacySanitized: true,
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
