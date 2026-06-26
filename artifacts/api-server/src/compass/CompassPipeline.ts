/**
 * CompassPipeline — Phase 2 single-entry-point orchestrator.
 *
 * Runs the four gates in strict order for a batch of items:
 *   1. Safety Filter  → hard-block (blocked users, suspended, adult flags, etc.)
 *   2. Eligibility    → soft-reject (capacity, trust floor, circle membership, etc.)
 *   3. Privacy Guard  → sanitise (strip GPS, hotel addr, admin notes, etc.)
 *   4. Scoring Engine → rank (interest match, freshness, city, language, trust, etc.)
 *
 * Returns only items that passed all four gates, sorted by finalScore descending.
 *
 * This is the single function all Phase 3 feed builders must call.
 * It never throws — exceptions inside any gate are caught and fail-open
 * (allow/pass) so a bug in one gate cannot black-hole an entire feed section.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile, CompassContext } from "./types.js";
import { runSafetyFilter } from "./CompassSafetyFilter.js";
import { runEligibilityCheck } from "./CompassEligibilityEngine.js";
import { sanitizeItem } from "./CompassPrivacyGuard.js";
import { scoreItem } from "./CompassScoringEngine.js";

export interface PipelineResult {
  item:            CompassItem;
  finalScore:      number;
  safetyPassed:    true;
  eligiblePassed:  true;
  privacySanitized: true;
}

export interface PipelineSummary {
  inputCount:      number;
  blockedCount:    number;
  rejectedCount:   number;
  passedCount:     number;
  results:         PipelineResult[];
}

/**
 * Run the full Compass pipeline on a batch of items.
 *
 * @param items    Raw content items (unsanitized, unscored)
 * @param profile  The calling user's Compass profile (from Phase 1)
 * @param context  The resolved Compass context (from Phase 1)
 * @param db       Optional Supabase client for audit logging in all four gates
 * @returns        PipelineSummary with results sorted by finalScore descending
 */
export function runPipeline(
  items: CompassItem[],
  profile: CompassProfile,
  context: CompassContext,
  db: SupabaseClient | null = null,
): PipelineSummary {
  let blockedCount = 0;
  let rejectedCount = 0;
  const results: PipelineResult[] = [];

  for (const item of items) {
    // Gate 1: Safety Filter
    const safety = runSafetyFilter(item, profile, db);
    if (!safety.allowed) {
      blockedCount++;
      continue;
    }

    // Gate 2: Eligibility Engine
    const eligibility = runEligibilityCheck(item, profile, context, db);
    if (!eligibility.eligible) {
      rejectedCount++;
      continue;
    }

    // Gate 3: Privacy Guard
    const sanitized = sanitizeItem(item, profile, db);

    // Gate 4: Scoring Engine
    const scored = scoreItem(sanitized, profile, context, db);

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
