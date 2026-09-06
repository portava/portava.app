/**
 * PassportContributionService
 *
 * Records contribution events for positive travel actions.
 * Does NOT modify Trust Score — it only appends records that a future
 * Trust Score engine can aggregate.
 * Double-credit on the same source_id is prevented by a unique index.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../../lib/featureFlags.js";

/** Capability flag for the §20 ledger. Seeded TRUE (migration 2084). */
export const CONTRIBUTION_EVENTS_FLAG = "passport_contribution_events_enabled";

export type ContributionEventType =
  | "city_visit_verified"
  | "plan_attendance_verified"
  | "plan_hosted"
  | "hidden_gem_verified"
  | "pulse_contribution"
  | "safe_return_completed"
  | "qr_checkin_validated"
  | "trip_crew_participation";

export interface RecordContributionInput {
  userId: string;
  eventType: ContributionEventType;
  sourceType?: string | null;
  sourceId?: string | null;
  verificationLevel?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Record a contribution event.
 * Returns true if inserted, false if duplicate or error.
 */
export async function recordContribution(
  db: SupabaseClient,
  input: RecordContributionInput,
): Promise<boolean> {
  const {
    userId, eventType, sourceType, sourceId,
    verificationLevel = "unverified",
    metadata = {},
  } = input;

  // If we have a source_id, check for existing record to avoid duplicate credit
  if (sourceId) {
    const { data: existing } = await db
      .from("passport_contribution_events")
      .select("id")
      .eq("user_id", userId)
      .eq("event_type", eventType)
      .eq("source_id", sourceId)
      .maybeSingle();

    if (existing) return false;
  }

  const { error } = await db
    .from("passport_contribution_events")
    .insert({
      user_id: userId,
      event_type: eventType,
      source_type: sourceType ?? null,
      source_id: sourceId ?? null,
      verification_level: verificationLevel,
      metadata,
    });

  return !error;
}

/**
 * Flag-gated, never-throwing wrapper for `recordContribution` — the shape every
 * PRODUCER should use.
 *
 * WHY THIS EXISTS. §20 reputation reads `passport_contribution_events`, and
 * until 2026-09-05 exactly ONE of the eight ContributionEventType values had a
 * writer anywhere in the repo (`city_visit_verified`, from the manual-memory
 * route, with `metadata` defaulted to `{}`). So `acceptedReports`,
 * `confirmations`, `hiddenGems`, `topExpertise` and `cityExpertise` were
 * permanently zero/empty for every traveller while the projection that derives
 * them was fully built and fully tested against fixture rows no producer could
 * create.
 *
 * A producer is a fire-and-forget side effect of an ALREADY-VERIFIED real-world
 * moment; it must never be able to fail the request that triggered it, so this
 * swallows everything and returns false.
 *
 * ALWAYS PASS `sourceId`. `passport_contribution_events_dedup_idx` is UNIQUE on
 * (user_id, event_type, source_id) WHERE source_id IS NOT NULL — without one,
 * a repeated action double-credits.
 */
export async function recordContributionIfEnabled(
  db: SupabaseClient | null | undefined,
  input: RecordContributionInput,
): Promise<boolean> {
  try {
    if (!db) return false;
    if (!(await isFlagEnabled(db, CONTRIBUTION_EVENTS_FLAG))) return false;
    return await recordContribution(db, input);
  } catch {
    return false;
  }
}

/**
 * Load contribution events for a user.
 */
export async function loadContributions(
  db: SupabaseClient,
  userId: string,
  limit = 50,
): Promise<any[]> {
  const { data, error } = await db
    .from("passport_contribution_events")
    .select("id, event_type, source_type, source_id, verification_level, metadata, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return [];
  return data ?? [];
}
