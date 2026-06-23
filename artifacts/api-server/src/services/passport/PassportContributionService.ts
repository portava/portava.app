/**
 * PassportContributionService
 *
 * Records contribution events for positive travel actions.
 * Does NOT modify Trust Score — it only appends records that a future
 * Trust Score engine can aggregate.
 * Double-credit on the same source_id is prevented by a unique index.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

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
